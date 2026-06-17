-- Add optionContract JSON column to IndiaDailyPick. Populated only for
-- INDICES_SCALP picks, where entry / stopLoss / target / canMoveUpto /
-- lastPrice are option premiums (₹/lot) rather than the index level.
ALTER TABLE "IndiaDailyPick" ADD COLUMN "optionContract" JSONB;
