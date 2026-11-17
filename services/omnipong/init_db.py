import asyncio
import os

from sqlalchemy.ext.asyncio import create_async_engine

from models import Base

# OMNIPONG_DB (added for OpenPong) overrides the SQLite file path; defaults to
# <service root>/omnipong.db. No personal data file is required to boot.
DB_PATH = os.getenv("OMNIPONG_DB") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "omnipong.db"
)
DATABASE_URL = f"sqlite+aiosqlite:///{DB_PATH}"

async def init_db():
    engine = create_async_engine(DATABASE_URL, echo=True)
    async with engine.begin() as conn:
        # Create all tables
        await conn.run_sync(Base.metadata.create_all)
    await engine.dispose()
    print(f"Database initialized successfully at {DB_PATH}")

if __name__ == "__main__":
    asyncio.run(init_db())
