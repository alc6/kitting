import { Hono } from "hono";
import { listBuilds } from "../domain/builds";
import { listParts } from "../domain/parts";
import { computeShortages, listPos } from "../domain/purchasing";
import { isStocked, valuation } from "../domain/stock";
import { fmt } from "../i18n";
import type { AppEnv } from "../types";
import { useApp } from "../views/context";
import { nowIso, page } from "../views/render";
import { Empty, LinkButton, Money, PageHeader, Qty } from "../views/ui";
import { BuildsTable } from "./builds";
import { PoTable } from "./purchasing";

export const dashboardRoutes = new Hono<AppEnv>();

const LIMIT = 10;

function More(props: { total: number; href: string }) {
	const { t } = useApp();
	return props.total > LIMIT ? (
		<p class="small">
			<a href={props.href}>{fmt(t.dashboard.more, { n: props.total - LIMIT })}</a>
		</p>
	) : null;
}

dashboardRoutes.get("/", async (c) => {
	const t = c.var.t;
	const db = c.var.db;
	const [allParts, shortages, openPos, open, done, value] = await Promise.all([
		listParts(db),
		computeShortages(db),
		listPos(db, { status: "open" }),
		listBuilds(db, { status: "open", limit: 100 }),
		listBuilds(db, { status: "done", limit: LIMIT }),
		valuation(db),
	]);
	const stocked = allParts.filter((p) => isStocked(p.kind));
	const belowZero = stocked.filter((p) => p.onHandMilli < 0);
	const belowMoq = stocked.filter((p) => p.moqMilli > 0 && p.onHandMilli >= 0 && p.onHandMilli < p.moqMilli);
	const shortageLines = shortages.groups.flatMap((g) => g.lines.map((l) => ({ ...l, supplierName: g.supplierName })));
	return page(
		c,
		t.dashboard.title,
		<>
			<PageHeader title={t.dashboard.title} />
			{allParts.length === 0 ? (
				<section class="card">
					<h2>{t.dashboard.welcome}</h2>
					<p>{t.dashboard.gettingStarted}</p>
					<LinkButton href="/import" label={t.nav.import} />
				</section>
			) : null}
			<div class="cards stats">
				<a class="card stat link" href="/builds">
					<h2>{t.dashboard.openBuilds}</h2>
					<p class="big">{open.length}</p>
				</a>
				<a class="card stat link" href="/purchasing">
					<h2>{t.dashboard.shortageLines}</h2>
					<p class={shortageLines.length ? "big warn" : "big"}>{shortageLines.length}</p>
				</a>
				<a class="card stat link" href="/purchasing/po">
					<h2>{t.dashboard.openPos}</h2>
					<p class="big">{openPos.length}</p>
				</a>
				<a class="card stat link" href="/stock/valuation">
					<h2>{t.dashboard.stockValue}</h2>
					<p class="big">
						<Money cents={value.totalCents} />
						{value.incomplete ? <span class="warn"> *</span> : null}
					</p>
				</a>
			</div>

			<section class="card">
				<div class="section-header">
					<h2>{t.dashboard.shortages}</h2>
					<a href="/purchasing">{t.dashboard.viewAll}</a>
				</div>
				{shortages.missingBoms.map((m) => (
					<p class="flash warning">{fmt(t.boms.missingBom, { ref: m.ref })}</p>
				))}
				{shortageLines.length === 0 ? (
					<Empty>{t.dashboard.noShortages}</Empty>
				) : (
					<table class="table">
						<thead>
							<tr>
								<th>{t.purchasing.part}</th>
								<th>{t.purchasing.supplier}</th>
								<th class="num">{t.purchasing.net}</th>
								<th class="num">{t.purchasing.order}</th>
							</tr>
						</thead>
						<tbody>
							{shortageLines.slice(0, LIMIT).map((l) => (
								<tr>
									<td>
										<a href={`/parts/${l.part.id}`}>{l.part.ref}</a> {l.part.name}
									</td>
									<td>{l.supplierName || <span class="warn">—</span>}</td>
									<td class="num warn">
										<Qty milli={l.netMilli} unit={l.part.unit} />
									</td>
									<td class="num">
										<Qty milli={l.orderMilli} unit={l.part.unit} />
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
				<More total={shortageLines.length} href="/purchasing" />
			</section>

			<div class="cards">
				<section class="card">
					<h2>{t.dashboard.alerts}</h2>
					{belowZero.length === 0 && belowMoq.length === 0 ? (
						<Empty>{t.dashboard.noAlerts}</Empty>
					) : (
						<table class="table">
							<tbody>
								{[
									...belowZero.map((p) => ({ p, label: t.dashboard.belowZero })),
									...belowMoq.map((p) => ({ p, label: t.dashboard.belowMoq })),
								]
									.slice(0, LIMIT * 2)
									.map(({ p, label }) => (
										<tr>
											<td>
												<a href={`/parts/${p.id}`}>{p.ref}</a> {p.name}
											</td>
											<td class="small muted">{label}</td>
											<td class={p.onHandMilli < 0 ? "num negative" : "num warn"}>
												<Qty milli={p.onHandMilli} unit={p.unit} />
											</td>
										</tr>
									))}
							</tbody>
						</table>
					)}
				</section>
				<section class="card">
					<div class="section-header">
						<h2>{t.dashboard.openPos}</h2>
						<a href="/purchasing/po">{t.dashboard.viewAll}</a>
					</div>
					<PoTable rows={openPos.slice(0, LIMIT)} today={nowIso().slice(0, 10)} />
					<More total={openPos.length} href="/purchasing/po" />
				</section>
			</div>

			<section class="card">
				<div class="section-header">
					<h2>{t.dashboard.upcoming}</h2>
					<LinkButton href="/builds/new" label={t.builds.new} variant="secondary" />
				</div>
				<BuildsTable rows={[...open].reverse().slice(0, LIMIT)} />
				<More total={open.length} href="/builds" />
			</section>
			<section class="card">
				<div class="section-header">
					<h2>{t.dashboard.lastBuilds}</h2>
					<a href="/builds?status=done">{t.dashboard.viewAll}</a>
				</div>
				<BuildsTable rows={done} />
			</section>
		</>,
	);
});
