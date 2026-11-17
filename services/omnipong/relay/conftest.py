"""Make the relay's flat modules importable when pytest runs from the service root.

The relay is deliberately a set of flat modules (`import config`, `import
protocol`) so `python server.py` works as a standalone process, exactly like
the upstream relay. This conftest puts this directory on sys.path first for
the tests collected from here.
"""
from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
