"""SHAP-based model explainability utilities."""

from .shap_explainer import ModelExplainer, format_explanation_text, get_feature_label

__all__ = ["ModelExplainer", "format_explanation_text", "get_feature_label"]
