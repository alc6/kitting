// Part picker results (D138): GET /parts/pick, loaded into the picker dialog by htmx. A read page like the
// parts list, open to every signed-in user, and it shows no price or cost. Mounted before partRoutes so that
// "/parts/pick" is never read as a part id.
import { Hono } from "hono";
import { imagesBucket } from "../domain/images";
import { searchPickerParts, validatePickerQuery } from "../domain/part-picker";
import type { AppEnv } from "../types";
import { PickerResults } from "../views/part-picker";
import { page } from "../views/render";
import { Alert, PageHeader } from "../views/ui";

export const pickerRoutes = new Hono<AppEnv>();

pickerRoutes.get("/", async (c) => {
	const t = c.var.t;
	const v = validatePickerQuery(c.req.query());
	// 422 is swapped by htmx like any validation error: the dialog shows the message in place of the results.
	if (!v.ok) {
		return page(
			c,
			t.picker.title,
			<>
				<PageHeader title={t.picker.title} />
				<div id="picker-results">
					<Alert variant="destructive">{t.picker.invalid}</Alert>
				</div>
			</>,
			422,
		);
	}
	const data = await searchPickerParts(c.var.db, v.data);
	return page(
		c,
		t.picker.title,
		<>
			<PageHeader title={t.picker.title} />
			<PickerResults data={data} query={v.data} images={imagesBucket(c.env) !== null} />
		</>,
	);
});
