import argparse
import asyncio
import sys

from browser_manager import BrowserManager
from omnipong_scraper import OmniPongScraper


async def run_sync(scope):
    print(f"\n{'=' * 70}")
    print("🎾 [SYNC SCRIPT] Starting Tournament Sync")
    print(f"🎾 [SYNC SCRIPT] Scope: {scope}")
    print(f"🎾 [SYNC SCRIPT] Python executable: {sys.executable}")
    print(f"🎾 [SYNC SCRIPT] Python version: {sys.version}")
    print(f"{'=' * 70}\n")

    print("🎾 [SYNC SCRIPT] Initializing BrowserManager...")
    manager = BrowserManager(user_data_dir="./playwright_sync_data")
    print("🎾 [SYNC SCRIPT] BrowserManager initialized")

    print("🎾 [SYNC SCRIPT] Initializing OmniPongScraper...")
    scraper = OmniPongScraper(manager)
    print("🎾 [SYNC SCRIPT] OmniPongScraper initialized")

    try:
        print("\n🎾 [SYNC SCRIPT] Attempting login to OmniPong...")
        login_result = await manager.login_omnipong()
        print(f"🎾 [SYNC SCRIPT] Login result: {login_result}")

        if not login_result:
            print("❌ [SYNC SCRIPT] Login failed - aborting sync")
            return

        print("✅ [SYNC SCRIPT] Login successful\n")
        activities_to_sync = []

        if scope in ["history", "all"]:
            print("🎾 [SYNC SCRIPT] Scraping tournament history...")
            hist = await scraper.scrape_my_tournament_history()
            print(f"🎾 [SYNC SCRIPT] Found {len(hist)} tournaments in history")
            activities_to_sync.extend(hist)

        if scope in ["regional", "all"]:
            print("🎾 [SYNC SCRIPT] Scraping regional tournaments...")
            reg = await scraper.scrape_regional_tournaments()
            print(f"🎾 [SYNC SCRIPT] Found {len(reg)} regional tournaments")
            activities_to_sync.extend(reg)

        print(
            f"\n🎾 [SYNC SCRIPT] Total tournaments to sync: {len(activities_to_sync)}"
        )

        if activities_to_sync:
            print("🎾 [SYNC SCRIPT] Starting bulk sync to database...")
            await scraper.bulk_sync_tournaments(activities_to_sync)
            print("✅ [SYNC SCRIPT] Bulk sync completed successfully")
        else:
            print("⚠️  [SYNC SCRIPT] No tournaments found to sync")

        print(f"\n{'=' * 70}")
        print("✅ [SYNC SCRIPT] Tournament Sync Complete")
        print(f"{'=' * 70}\n")

    except Exception as e:
        print(f"\n{'=' * 70}")
        print(f"❌ [SYNC SCRIPT] Error during sync: {type(e).__name__}")
        print(f"❌ [SYNC SCRIPT] Error message: {e!s}")
        print(f"{'=' * 70}\n")
        import traceback

        print("❌ [SYNC SCRIPT] Full traceback:")
        traceback.print_exc()
        print(f"{'=' * 70}\n")
        sys.exit(1)
    finally:
        print("🎾 [SYNC SCRIPT] Stopping BrowserManager...")
        await manager.stop()
        print("🎾 [SYNC SCRIPT] BrowserManager stopped")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--scope", default="regional", help="Scope: history, regional, all"
    )
    args = parser.parse_args()

    asyncio.run(run_sync(args.scope))
