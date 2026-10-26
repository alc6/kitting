# Administration

## Roles

Cloudflare Access decides who can sign in. Kitting decides what each person can do, with four roles:

| Role | What they can do |
| --- | --- |
| Viewer | See everything, change nothing. |
| Operator | Shop-floor work: run builds, adjust and count stock, receive deliveries. |
| Planner | Office work as well: edit parts, assemblies, files, suppliers, machines, offers, prices and purchase orders, export data and preview imports. |
| Administrator | Everything: confirm imports, delete and archive, restore backups, manage users. |

The people listed in `ADMIN_EMAILS` are always administrators. They give everyone else a role on the **Users and
roles** page (Administration, in the sidebar): *Add a user* above the list, or pick another role in a person's row and
save. The four roles are described beside the list, and the full table of who can do what is below it. Anyone who
signs in without being listed is a viewer and can't connect an AI assistant. A role change applies on the person's
next page load.

Costs, prices, valuations and margins are hidden from viewers and operators, unless an administrator turns on
*Viewers and operators see costs* on the Users and roles page, at the top of that table. They show "Hidden" instead of amounts, and CSV exports
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
  deleted. Past prices added to a part's price history (from the part page or `price_history.csv`) can't be undone
  either: the price history is a log that is never edited. An administrator can delete a wrong row with the bin
  button on the part's price history, except the current price of its series (change that one on the part's
  form). The deletion is recorded in Recent changes and can't be undone either.
- Removing a file from a part or an assembly revision can be undone: the file itself stays in storage, and the undo
  attaches it again. So can replacing one, which brings the previous file back.
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

Product photos and attached files aren't in that file, only which photo each part uses and the list of files (name,
kind, size, who uploaded them, where they are stored). Their content stays in the R2 bucket, under `parts/` for
photos and `files/` for files; copy the bucket with any S3-compatible tool if you want an offsite copy. Restored on
another deployment without that copy, the files are listed but their downloads say the file is missing from storage.
If a photo was replaced or removed after the backup, the restored part has no photo; removed and replaced files are
kept in the bucket, so the files of a restored backup are still there.

D1 also keeps 30 days of point-in-time history (Time Travel), and wrangler can export the database as SQL:

```bash
npx wrangler d1 export kitting --remote --output kitting-backup.sql
```
