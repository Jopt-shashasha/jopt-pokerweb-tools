// These routes are mounted on the existing images router, behind the deployed
// authentication/CSRF middleware. No credentials are sent to the browser.
images.get('/api/storage-migration', requireRole('owner'), c => {
  c.header('Cache-Control', 'private, no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  return c.html(HARNESS_MIGRATION_HTML);
});
images.get('/api/storage-migration/inventory', requireRole('owner'), async c => {
  c.header('Cache-Control', 'private, no-store');
  if (c.env.R2_MIGRATION_ENABLED !== '1' || c.env.R2_MIGRATION_READS !== 'enabled') return c.json({ success:false,error:'migration_disabled' },403);
  const cursor = c.req.query('cursor');
  if (cursor && cursor.length > 4096) return c.json({ success:false,error:'invalid_cursor' },400);
  try {
    const page = await new AppwriteObjectStorage(c.env).list({ cursor });
    return c.json({ success:true,data:{ keys:page.objects.map(x=>x.key).filter(harnessMigrationKey),truncated:page.truncated,cursor:page.cursor||null } });
  } catch { return c.json({ success:false,error:'source_inventory_unavailable' },502); }
});
images.post('/api/storage-migration/copy', requireRole('owner'), async c => {
  c.header('Cache-Control', 'private, no-store');
  if (c.env.R2_MIGRATION_ENABLED !== '1' || c.env.R2_MIGRATION_READS !== 'enabled') return c.json({ success:false,error:'migration_disabled' },403);
  try {
    const body = await c.req.json();
    const data = await harnessMigrateBatch(c.env,new AppwriteObjectStorage(c.env),body.keys);
    return c.json({ success:true,data });
  } catch { return c.json({ success:false,error:'migration_batch_unavailable' },400); }
});
