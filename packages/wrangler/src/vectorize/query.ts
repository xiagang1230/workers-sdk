import { readConfig } from "../config";
import { logger } from "../logger";
import { queryIndexByVector, queryIndexByVectorId } from "./client";
import { vectorizeGABanner } from "./common";
import type {
	CommonYargsArgv,
	StrictYargsOptionsToInterface,
} from "../yargs-types";
import type {
	VectorizeMatches,
	VectorizeMetadataFilterValue,
	VectorizeMetadataRetrievalLevel,
	VectorizeQueryOptions,
	VectorizeVectorMetadataFilter,
	VectorizeVectorMetadataFilterOp,
} from "./types";

export function options(yargs: CommonYargsArgv) {
	return yargs
		.positional("name", {
			type: "string",
			demandOption: true,
			description: "The name of the Vectorize index",
		})
		.options({
			vector: {
				type: "array",
				describe: "Vector to query the Vectorize Index",
				coerce: (arg: unknown[]) =>
					arg
						.map((value) =>
							typeof value === "string" ? parseFloat(value) : value
						)
						.filter(
							(value): value is number =>
								typeof value === "number" && !isNaN(value)
						),
			},
			"vector-id": {
				type: "string",
				describe:
					"Identifier for a vector in the index against which the index should be queried",
			},
			"top-k": {
				type: "number",
				default: 5,
				describe: "The number of results (nearest neighbors) to return",
			},
			"return-values": {
				type: "boolean",
				default: false,
				describe:
					"Specify if the vector values should be included in the results",
			},
			"return-metadata": {
				type: "string",
				choices: ["all", "indexed", "none"],
				default: "none",
				describe:
					"Specify if the vector metadata should be included in the results",
			},
			namespace: {
				type: "string",
				describe: "Filter the query results based on this namespace",
			},
			filter: {
				type: "string",
				describe: "Filter the query results based on this metadata filter.",
				coerce: (jsonStr: string): VectorizeQueryOptions["filter"] => {
					try {
						return JSON.parse(jsonStr);
					} catch (_) {
						logger.warn(
							"🚨 Invalid query filter. Please use the recommended format."
						);
					}
				},
			},
		})
		.example([
			[
				`❯❯ wrangler vectorize query --vector 1 2 3 0.5 1.25 6\n` +
					"   Query the Vectorize Index by vector. To read from a json file that contains data in the format [1, 2, 3], you could use a command like\n" +
					"   `wrangler vectorize query --vector $(jq -r '.[]' data.json | xargs)`\n",
			],
			[
				"❯❯ wrangler vectorize query --filter '{ 'p1': 'abc', 'p2': { '$ne': true }, 'p3': 10, 'p4': false, 'nested.p5': 'abcd' }'\n" +
					"   Filter the query results.",
			],
		])
		.epilogue(vectorizeGABanner);
}

export async function handler(
	args: StrictYargsOptionsToInterface<typeof options>
) {
	const config = readConfig(args);

	const queryOptions: VectorizeQueryOptions = {
		topK: args.topK,
		returnValues: args.returnValues,
		returnMetadata: args.returnMetadata as VectorizeMetadataRetrievalLevel,
	};

	if (args.namespace) {
		queryOptions.namespace = args.namespace;
	}

	if (args.filter) {
		const parsedFilter = validateQueryFilter(args.filter);
		if (!parsedFilter) {
			logger.warn(
				"🚨 Could not parse the provided query filter. Please use the recommended format."
			);
		} else {
			queryOptions.filter = parsedFilter;
		}
	}

	if (
		(args.vector === undefined && args.vectorId === undefined) ||
		(args.vector !== undefined && args.vectorId !== undefined)
	) {
		logger.error(
			"🚨 Either vector or vector-id parameter must be provided, but not both."
		);
		return;
	}

	logger.log(`📋 Searching for relevant vectors...`);
	let res: VectorizeMatches | undefined;
	if (args.vector !== undefined) {
		res = await queryIndexByVector(
			config,
			args.name,
			args.vector,
			queryOptions
		);
	} else if (args.vectorId !== undefined) {
		res = await queryIndexByVectorId(
			config,
			args.name,
			args.vectorId,
			queryOptions
		);
	}

	if (res === undefined || res.count === 0) {
		logger.warn(`Could not find any relevant vectors`);
		return;
	}

	logger.log(JSON.stringify(res, null, 2));
}

function validateQueryFilterInnerValue(
	innerValue: VectorizeMetadataFilterValue
) {
	return ["string", "number", "boolean"].includes(typeof innerValue);
}

export function validateQueryFilter(
	input: object
): VectorizeVectorMetadataFilter | null {
	try {
		const parsedObj = input;

		// Check if the parsed result is an object, not null, and not an array
		if (
			typeof parsedObj !== "object" ||
			parsedObj === null ||
			Array.isArray(parsedObj)
		) {
			// Invalid json
			return null;
		}

		const result: VectorizeVectorMetadataFilter = {};

		for (const field in parsedObj) {
			if (Object.prototype.hasOwnProperty.call(parsedObj, field)) {
				const value = (
					parsedObj as Record<string, VectorizeVectorMetadataFilter>
				)[field];

				if (Array.isArray(value)) {
					// Skip arrays
					continue;
				}

				if (typeof value === "object" && value !== null) {
					// Handle nested objects
					const innerObj: VectorizeVectorMetadataFilter = {};
					let validInnerObj = true;

					for (const op in value) {
						if (Object.prototype.hasOwnProperty.call(value, op)) {
							const innerValue = value[op];
							if (["$eq", "$ne", "$lt", "$lte", "$gt", "gte"].includes(op)) {
								if (!validateQueryFilterInnerValue(innerValue)) {
									validInnerObj = false;
								}
							} else if (["$in", "$nin"].includes(op)) {
								if (!Array.isArray(innerValue)) {
									validInnerObj = false;
								} else {
									if (!innerValue.every(validateQueryFilterInnerValue)) {
										validInnerObj = false;
									}
								}
							} else {
								validInnerObj = false;
							}

							innerObj[op as VectorizeVectorMetadataFilterOp] = innerValue;
						}
					}

					// Only add valid and non-empty innerObj to result
					if (validInnerObj && Object.keys(innerObj).length > 0) {
						result[field] = innerObj as VectorizeMetadataFilterValue;
					} else if (validInnerObj) {
						// Invalid innerObj
					}
				} else {
					// Ensure value is of type Exclude<MdV, string[]> (i.e., string | number | boolean | null)
					result[field] = value;
				}
			}
		}

		if (Object.keys(result).length > 0) {
			return result;
		} else {
			// Empty result
			return null;
		}
	} catch (error) {
		// Error parsing
		return null;
	}
}
