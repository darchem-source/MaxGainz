import asyncio
from playwright.async_api import async_playwright
SEED = open('/home/claude/appstore-team/screenshots/seed.js').read()
async def open_app(p, w=430, h=932):
    b = await p.chromium.launch()
    ctx = await b.new_context(viewport={'width':w,'height':h}, device_scale_factor=3, is_mobile=True, has_touch=True, timezone_id='Europe/London', locale='en-GB')
    await ctx.route(lambda u: 'localhost' not in u, lambda r: r.abort())
    async def bridge(route):
        r = await route.fetch(); t = await r.text()
        await route.fulfill(response=r, body=t.replace("__MG_RC_API_KEY__","appl_demo"), headers={**r.headers,'content-type':'application/javascript'})
    await ctx.route('**/native-bridge.js', bridge)
    async def idx(route):
        r = await route.fetch(); t = await r.text()
        old = "value: vol + 'kg'"
        assert old in t
        t = t.replace(old, "value: vol + (/k$/.test(vol) ? '' : 'kg')")
        await route.fulfill(response=r, body=t, headers={**r.headers,'content-type':'text/html'})
    await ctx.route('**/index.html', idx)
    await ctx.add_init_script(SEED)
    pg = await ctx.new_page()
    pg.on('pageerror', lambda e: print('pageerror', e))
    await pg.goto('http://localhost:8765/index.html')
    await pg.wait_for_timeout(4500)
    return b, pg
