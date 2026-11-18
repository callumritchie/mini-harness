"""The price list, and what a call costs. Prices are US dollars per million tokens.

Sources, checked 2026-11-18: Anthropic https://platform.claude.com/docs/en/about-claude/pricing and DeepSeek
https://api-docs.deepseek.com/quick_start/pricing. Prices change: update this table when they do. A model that is not
in the table is reported as unpriced, never as $0.
"""
import datetime
import re

CHECKED = "2026-11-18"
SEARCH_USD = 0.01  # Anthropic web search: $10 per 1,000 searches, on top of the tokens it produces

# model -> (input, cache write (5 minute), cache read, output)
ANTHROPIC = {
    "claude-fable-5-2": (8, 10, 0.20, 40), "claude-mythos-5-2": (8, 10, 0.20, 40),
    "claude-fable-5-1": (10, 12.5, 0.25, 50), "claude-mythos-5-1": (10, 12.5, 0.25, 50),
    "claude-fable-5": (10, 12.5, 1, 50), "claude-mythos-5": (10, 12.5, 1, 50),
    "claude-opus-5-5": (4, 5, 0.20, 20),
    "claude-opus-5": (5, 6.25, 0.50, 25), "claude-opus-4-8": (5, 6.25, 0.50, 25), "claude-opus-4-7": (5, 6.25, 0.50, 25),
    "claude-opus-4-6": (5, 6.25, 0.50, 25), "claude-opus-4-5": (5, 6.25, 0.50, 25),
    "claude-opus-4-1": (15, 18.75, 1.5, 75), "claude-opus-4": (15, 18.75, 1.5, 75),
    "claude-sonnet-5-5": (2, 2.5, 0.10, 10), "claude-sonnet-5": (2, 2.5, 0.20, 10),
    "claude-sonnet-4-6": (3, 3.75, 0.30, 15), "claude-sonnet-4-5": (3, 3.75, 0.30, 15), "claude-sonnet-4": (3, 3.75, 0.30, 15),
    "claude-haiku-4-5": (1, 1.25, 0.10, 5),
}
HAIKU_55 = {"low": (0.10, 0.125, 0.01, 0.50), "high": (0.50, 0.625, 0.05, 2.50)}  # prompts up to / over 100,000 tokens
# DeepSeek: (cache miss input, cache miss input again as the 'write' price, cache hit, output), off-peak. Peak is double.
DEEPSEEK = {
    "deepseek-flash": (0.15, 0.15, 0.003, 0.60), "deepseek-v4-flash": (0.15, 0.15, 0.003, 0.60),
    "deepseek-v4-flash-vision-exp": (0.15, 0.15, 0.003, 0.60),
    "deepseek-v4-pro": (0.66, 0.66, 0.022, 1.98),
}


def _lookup(table, model):
    for key in sorted(table, key=len, reverse=True):  # a dated id such as claude-haiku-4-5-20251001 matches its base id
        if model == key or re.fullmatch(re.escape(key) + r"-\d{8}", model):
            return key
    return None


def is_deepseek_peak(now):
    """DeepSeek charges double Monday-Friday 01:00-04:00 and 06:00-10:00 UTC. (Chinese public holidays are off-peak; we do not know them.)"""
    return now.weekday() < 5 and (1 <= now.hour < 4 or 6 <= now.hour < 10)


def prices(model, prompt_tokens=0, now=None):
    """(input, cache write, cache read, output) per million tokens, or None if the model is not in the list."""
    if model == "claude-haiku-5-5" or re.fullmatch(r"claude-haiku-5-5-\d{8}", model):
        return HAIKU_55["high" if prompt_tokens > 100_000 else "low"]
    key = _lookup(ANTHROPIC, model)
    if key:
        return ANTHROPIC[key]
    key = _lookup(DEEPSEEK, model)
    if key:
        now = now or datetime.datetime.now(datetime.timezone.utc)
        factor = 2 if is_deepseek_peak(now) else 1
        return tuple(p * factor for p in DEEPSEEK[key])
    return None


def cost(model, usage, now=None):
    """Dollar cost of one call, or None if the model has no price. usage: input (uncached), cache_read, cache_write, output,
    and optionally searches (web searches the provider ran)."""
    prompt = usage.get("input", 0) + usage.get("cache_read", 0) + usage.get("cache_write", 0)
    p = prices(model, prompt, now)
    if p is None:
        return None
    inp, write, read, out = p
    usd = (usage.get("input", 0) * inp + usage.get("cache_write", 0) * write + usage.get("cache_read", 0) * read
           + usage.get("output", 0) * out) / 1_000_000
    if model.startswith("claude-"):
        usd += usage.get("searches", 0) * SEARCH_USD
    return usd


def money(usd):
    if usd is None:
        return "unpriced"
    return f"${usd:,.4f}" if usd < 1 else f"${usd:,.2f}"


def missing_note(model):
    return f"no price for model '{model}' in pricing.py, so its cost is not counted (not $0)"
