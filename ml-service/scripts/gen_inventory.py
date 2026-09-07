"""Generate reports/phase-3d-feature-inventory.csv"""
import sys, csv
sys.path.insert(0, 'src')
from features.registry import FEATURE_REGISTRY, list_data_unavailable_features
from features.schemas import FeaturePromotion, PITSafety

UNAVAIL = set(list_data_unavailable_features())
rows = []

for name, spec in sorted(FEATURE_REGISTRY.items()):
    is_data_unavail = name in UNAVAIL
    pit = spec.pit_safety
    pit_str = "TRUE" if pit == PITSafety.SAFE else ("FALSE" if pit == PITSafety.UNSAFE else "UNVERIFIED")
    rows.append({
        "feature": name,
        "family": spec.family.value,
        "version": spec.feature_version,
        "source": spec.source,
        "formula_id": spec.formula_id,
        "lookback": spec.lookback,
        "frequency": spec.bar_frequency,
        "PIT_safe": pit_str,
        "availability": "DATA_UNAVAILABLE" if is_data_unavail else "COMPUTABLE",
        "missing_policy": spec.missing_policy.value,
        "cross_sectional": "TRUE" if spec.cross_sectional else "FALSE",
        "proxy": "TRUE" if spec.proxy_for else "FALSE",
        "talib_required": "TRUE" if "talib_required" in spec.tags else "FALSE",
        "status": spec.promotion.value,
        "deprecated_by": spec.deprecated_by or "",
        "description": spec.description[:80],
    })

fieldnames = [
    "feature","family","version","source","formula_id","lookback","frequency",
    "PIT_safe","availability","missing_policy","cross_sectional","proxy",
    "talib_required","status","deprecated_by","description",
]
outfile = "reports/phase-3d-feature-inventory.csv"
with open(outfile, "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=fieldnames)
    w.writeheader()
    w.writerows(rows)
print(f"Wrote {len(rows)} rows to {outfile}")
