import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { parts, suppliers } from "../db/schema";
import { fmt } from "../i18n";
import type { AppEnv } from "../types";
import { page } from "../views/render";
import { LinkButton, PageHeader } from "../views/ui";

export const dashboardRoutes = new Hono<AppEnv>();

dashboardRoutes.get("/", async (c) => {
	const t = c.var.t;
	const db = c.var.db;
	const [partCount, supplierCount] = await Promise.all([
		db.select({ n: sql<number>`count(*)` }).from(parts).where(sql`${parts.archived} = 0`),
		db.select({ n: sql<number>`count(*)` }).from(suppliers),
	]);
	const nParts = partCount[0]?.n ?? 0;
	return page(
		c,
		t.dashboard.title,
		<>
			<PageHeader title={t.dashboard.title} />
			{nParts === 0 ? (
				<section class="card">
					<h2>{t.dashboard.welcome}</h2>
					<p>{t.dashboard.gettingStarted}</p>
					<LinkButton href="/import" label={t.nav.import} />
				</section>
			) : null}
			<div class="cards">
				<a class="card stat link" href="/parts">
					<h2>{t.nav.parts}</h2>
					<p class="big">{fmt(t.dashboard.partsCount, { n: nParts })}</p>
				</a>
				<a class="card stat link" href="/suppliers">
					<h2>{t.nav.suppliers}</h2>
					<p class="big">{fmt(t.dashboard.suppliersCount, { n: supplierCount[0]?.n ?? 0 })}</p>
				</a>
			</div>
		</>,
	);
});
