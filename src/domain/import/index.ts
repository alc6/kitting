import { parseCsv } from "../../lib/csv";
import { assembliesImporter } from "./assemblies";
import { machinesImporter, machineTypesImporter } from "./machines";
import { offersImporter } from "./offers";
import { partsImporter } from "./parts";
import { priceHistoryImporter } from "./price-history";
import { stockImporter } from "./stock";
import { suppliersImporter } from "./suppliers";
import type { ImportContext, Importer, ImportPlan, ImportType } from "./types";

export * from "./types";

/** Importers in the order data should be loaded. */
export const IMPORTERS: Importer[] = [
	suppliersImporter,
	partsImporter,
	offersImporter,
	priceHistoryImporter,
	machineTypesImporter,
	machinesImporter,
	assembliesImporter,
	stockImporter,
];

export function importerFor(type: string): Importer | undefined {
	return IMPORTERS.find((i) => i.type === type);
}

export function headerOf(importer: Importer): string[] {
	return importer.columns ?? [...importer.required, ...importer.optional];
}

export async function planImport(
	ctx: ImportContext,
	type: ImportType,
	csvText: string,
): Promise<ImportPlan | undefined> {
	const importer = importerFor(type);
	if (!importer) return undefined;
	const plan = await importer.plan(ctx, parseCsv(csvText));
	plan.errors.sort((a, b) => a.line - b.line);
	return plan;
}
