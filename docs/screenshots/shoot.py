import asyncio, sys, os
from playwright.async_api import async_playwright
import lib
W, H, OUT = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
os.makedirs(OUT, exist_ok=True)
async def main():
    async with async_playwright() as p:
        b, pg = await lib.open_app(p, W, H)
        # cosmetic repair applied to the served copy only (share card prints "1.8kkg"; see report)
        shot = lambda n: pg.screenshot(path=f'{OUT}/{n}.png')
        await pg.add_style_tag(content='::-webkit-scrollbar{display:none}')
        # 01 session + rest timer
        await pg.get_by_text('Start Session').first.click(); await pg.wait_for_timeout(1200)
        await pg.evaluate("dismissWarmupBanner()")
        for i in range(3):
            await pg.evaluate("advance()"); await pg.wait_for_timeout(400)
            await pg.evaluate("confirmReps()"); await pg.wait_for_timeout(700)
        await pg.wait_for_timeout(3000)
        await shot('01-log-every-set')
        # share card: log more sets, fake a realistic elapsed time, finish
        for i in range(9):
            await pg.evaluate("advance()"); await pg.wait_for_timeout(250)
            await pg.evaluate("confirmReps()"); await pg.wait_for_timeout(350)
        await pg.evaluate("sessStartTime = Date.now() - 52*60000"); await pg.wait_for_timeout(1300)
        await pg.evaluate("confirmFinishSession()"); await pg.wait_for_timeout(400)
        await pg.evaluate("document.getElementById('finishOptionsMod').classList.remove('open');finishSession()"); await pg.wait_for_timeout(2500)
        await pg.evaluate("generateShareCard()"); await pg.wait_for_timeout(1500)
        await shot('07-share-your-win')
        await pg.evaluate("document.getElementById('shareCardMod').classList.remove('open');closeFinish()"); await pg.wait_for_timeout(1000)
        # 02 path
        await pg.evaluate("goTab('path',document.getElementById('nav-path'))"); await pg.wait_for_timeout(1500)
        await shot('02-follow-a-path')
        # 04/05 progress
        await pg.evaluate("goTab('progress',document.getElementById('nav-progress'))"); await pg.wait_for_timeout(800)
        await pg.evaluate("setProgressSubTab('strength',document.querySelector('#progSubTabs .chip[data-tab=strength]'))"); await pg.wait_for_timeout(1500)
        await shot('04-track-your-lifts')
        await pg.evaluate("setProgressSubTab('volume',document.querySelector('#progSubTabs .chip[data-tab=volume]'))"); await pg.wait_for_timeout(800)
        await pg.evaluate("setMuscleHeatmapWindow(28)"); await pg.wait_for_timeout(1200)
        await shot('05-muscle-balance')
        # 06 gainz
        await pg.evaluate("goTab('game',document.getElementById('nav-game'))"); await pg.wait_for_timeout(1500)
        await shot('06-ranks-and-achievements')
        # 03 HIIT
        await pg.evaluate("goTab('today',document.getElementById('nav-today'))"); await pg.wait_for_timeout(500)
        i = await pg.evaluate("HIIT.findIndex(h=>h.format==='Tabata')")
        await pg.evaluate(f"startHIIT({i})"); await pg.wait_for_timeout(1500)
        await pg.locator('#s-active button[onclick="handleHIITStart()"]:visible').first.click()
        await pg.wait_for_timeout(11500)
        await shot('03-hiit-timers')
        await pg.evaluate("cancelSession && (window.confirm=()=>true, cancelSession())"); await pg.wait_for_timeout(800)
        # 08 paywall
        await pg.evaluate("goTab('today',document.getElementById('nav-today'))"); await pg.wait_for_timeout(600)
        await pg.evaluate("document.querySelectorAll('.modal-ov.open').forEach(m=>m.classList.remove('open'))")
        await pg.evaluate("openPaywall('settings')"); await pg.wait_for_timeout(1500)
        await shot('08-free-trial-paywall')
        await b.close()
asyncio.run(main())
