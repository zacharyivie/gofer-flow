from __future__ import annotations

import logging
import sys

_configured = False


def configure_logging(level: str = "INFO") -> None:
    global _configured
    if _configured:
        return
    logging.basicConfig(
        stream=sys.stderr,
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    _configured = True


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)
