# Administration

## Roles

Cloudflare Access decides who can sign in. Kitting decides what each person can do, with four roles:

| Role | What they can do |
| --- | --- |
| Viewer | See everything, change nothing. |
| Operator | Shop-floor work: run builds, adjust and count stock, receive deliveries. |
| Planner | Office work as well: edit parts, assemblies, suppliers, offers, prices and purchase orders, export data and preview imports. |
| Administrator | Everything: confirm imports, delete and archive, restore backups, manage users. |

The people listed in `ADMIN_EMAILS` are always administrators. They give everyone else a role on the **Users**
page, and the full table of who can do what is shown there too. Anyone who signs in without being listed is a
viewer and can't connect an AI assistant. A role change applies on the person's next page load.

Costs, prices, valuations and margins are hidden from viewers and operators, unless an administrator turns on
*Viewers and operators see costs* on the Users page. They show "Hidden" instead of amounts, and CSV exports
leave the amount columns out.

Every permission is checked on the server. Hiding a button is only a convenience: a request the role doesn't
allow gets a 403.

## Change history and undo

Every change to the catalogue, purchase orders, builds, users and settings is recorded: who made it, when, where
it came from (a page, an import, an undo or an AI assistant), and each record it touched, before and after.

- **Recent changes**, in the sidebar, lists them newest first, with filters by origin, person, date and text.
  A change's page shows each field that changed, for example "quantity: 1 → 3".
- Parts, suppliers, assemblies and purchase orders also have a **History** tab with their own changes, including
  changes to their offers or lines.
- **Undo** restores the previous values as a new change, which can itself be undone. It is refused, and nothing
  changes, when a later change touched the same record (undo that one first), or when the old values no longer
  fit, for example a part reference that another part has taken since. The message says which record and who
  changed it.
- Stock movements can't be undone: completed builds, receipts, adjustments and counts are corrected with a new
  movement instead. Replacing or removing a product photo can't be undone either, since the old file is
  deleted.
- To undo a change, you need the right to make every edit it contains. An operator can undo a planned build but
  not a part edit, and only an administrator can undo archiving a part.

The database refuses writes to these tables made outside a recorded change. If you need to fix data by hand
with `wrangler d1 execute --file`, open a change at the top of the same file and close it at the end:

```sql
INSERT INTO change_sets (user_email, source, summary) VALUES ('admin@example.com', 'migration', 'Fix part units');
INSERT INTO change_context (id, change_set_id) VALUES (1, (SELECT max(id) FROM change_sets));
UPDATE parts SET unit = 'pcs' WHERE unit = '';
DELETE FROM change_context;
```

## Backups

Administrators can download a backup from **Import / Export → Backup**: the whole database, roles and change
history included, in one JSON file. It can be restored on the same deployment or another one running the same
version of Kitting. A preview shows what the file contains, then everything is replaced in one transaction. A
restore appears in Recent changes and can't be undone, except by restoring another backup.

Product photos aren't in that file, only which photo each part uses. The photos stay in the R2 bucket; copy it
with any S3-compatible tool if you want an offsite copy. If a photo was replaced or removed after the backup,
the restored part has no photo.

D1 also keeps 30 days of point-in-time history (Time Travel), and wrangler can export the database as SQL:

```bash
npx wrangler d1 export kitting --remote --output kitting-backup.sql
```
