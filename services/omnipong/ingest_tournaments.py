import asyncio
import json
import os
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

from models import Activity

# OMNIPONG_DB (added for OpenPong) overrides the SQLite file path.
DATABASE_URL = f"sqlite+aiosqlite:///{os.getenv('OMNIPONG_DB') or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'omnipong.db')}"
engine = create_async_engine(DATABASE_URL)
AsyncSessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

TOURNAMENTS_JSON = """
[
  {
    "source_id": "https://www.omnipong.com/Members.asp?ae=13917&h=5448",
    "title": "2026 USATT Southwest Championships * ONLY PAID ENTRIES are guaranteed spots *",
    "date_range": "02/13/26 - 02/15/26",
    "city_state": "Katy, TX"
  },
  {
    "source_id": "https://www.omnipong.com/Members.asp?ae=13917&h=5454",
    "title": "WTT YC Houston 2026 - Entry for US Players",
    "date_range": "03/20/26 - 03/23/26",
    "city_state": "Katy, TX"
  },
  {
    "source_id": "https://www.omnipong.com/Members.asp?ae=13917&h=5321",
    "title": "Winter Open - Top Spin USA -DATE CHANGE DUE TO WEATHER",
    "date_range": "01/31/26",
    "city_state": "Plano, TX"
  },
  {
    "source_id": "https://www.omnipong.com/Members.asp?ae=13917&h=5472",
    "title": "SATTC Butterfly Winter Open",
    "date_range": "02/21/26",
    "city_state": "San Antonio, TX"
  },
  {
    "source_id": "https://www.omnipong.com/Members.asp?ae=13917&h=4864",
    "title": "2026 Heritage TTC Spring Open",
    "date_range": "02/21/26 - 02/22/26",
    "city_state": "Allen, TX"
  },
  {
    "source_id": "https://www.omnipong.com/Members.asp?ae=13917&h=5322",
    "title": "Lunar New Year Open -Top Spin USA",
    "date_range": "02/28/26",
    "city_state": "Plano, TX"
  },
  {
    "source_id": "https://www.omnipong.com/Members.asp?ae=13917&h=5107",
    "title": "2026 AUSTIN BUTTERFLY NEW YEAR OPEN (increased money prizes !!!)",
    "date_range": "02/28/26",
    "city_state": "Austin, TX"
  },
  {
    "source_id": "https://www.omnipong.com/Members.asp?ae=13917&h=5456",
    "title": "2026 DFWTT Spring Open",
    "date_range": "03/14/26",
    "city_state": "Irving, TX"
  },
  {
    "source_id": "https://www.omnipong.com/Members.asp?ae=13917&h=5323",
    "title": "Top Spin USA SPRING OPEN",
    "date_range": "03/28/26",
    "city_state": "Plano, TX"
  },
  {
    "source_id": "https://www.omnipong.com/Members.asp?ae=13917&h=5387",
    "title": "2026 Butterfly Houston Lunar New Year",
    "date_range": "03/28/26",
    "city_state": "Houston, TX"
  },
  {
    "source_id": "https://www.omnipong.com/Members.asp?ae=13917&h=5278",
    "title": "2026 Spring Gppctx SpinMaster",
    "date_range": "04/18/26",
    "city_state": "Irving, TX"
  },
  {
    "source_id": "https://www.omnipong.com/Members.asp?ae=13917&h=5324",
    "title": "April Smash Open - Top Spin USA",
    "date_range": "04/25/26",
    "city_state": "Plano, TX"
  },
  {
    "source_id": "https://www.omnipong.com/Members.asp?ae=13917&h=5328",
    "title": "Yinhe May Open - Top Spin USA",
    "date_range": "05/16/26",
    "city_state": "Plano, TX"
  }
]
"""

async def ingest():
    data = json.loads(TOURNAMENTS_JSON)
    print(f"Ingesting {len(data)} tournaments...")
    
    async with AsyncSessionLocal() as session:
        for t in data:
            # Parse date (start date)
            try:
                date_str = t['date_range'].split(' - ')[0] if ' - ' in t['date_range'] else t['date_range']
                dt = datetime.strptime(date_str, "%m/%d/%y").date()
            except Exception:
                dt = None
            
            # Check existing
            stmt = select(Activity).where(Activity.source_id == t['source_id'])
            result = await session.execute(stmt)
            existing = result.scalar_one_or_none()
            
            if existing:
                print(f"Updating: {t['title']}")
                existing.title = t['title']
                existing.date = dt
                existing.location = t['city_state']
                existing.city_state = t['city_state']
                existing.last_scraped = datetime.utcnow()
            else:
                print(f"Adding: {t['title']}")
                new_act = Activity(
                    source="omnipong",
                    source_id=t['source_id'],
                    title=t['title'],
                    activity_type='tournament',
                    date=dt,
                    location=t['city_state'],
                    city_state=t['city_state'],
                    status='upcoming',
                    last_scraped=datetime.utcnow()
                )
                session.add(new_act)
        
        await session.commit()
    print("Ingestion complete.")

if __name__ == "__main__":
    asyncio.run(ingest())
