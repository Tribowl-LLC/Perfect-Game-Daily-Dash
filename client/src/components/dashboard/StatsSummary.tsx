import * as React from "react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchDailySummary, fetchDetailedTransactions } from "@/lib/squareApi";
import { DateRange } from "@shared/schema";
import { formatCurrency, formatPercentage, isPositiveChange } from "@/lib/dateUtils";
import { Skeleton } from "@/components/ui/skeleton";
import SimpleBarChart from "./SimpleBarChart";
import {
  ChevronUp,
  ChevronDown,
  TrendingUp,
  DollarSign,
  Users,
  Receipt,
  Tag,
  CreditCard,
  Percent,
  Award,
  Wallet,
  Info,
  Check,
  X
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface StatsSummaryProps {
  dateRange: DateRange;
  customStartDate?: Date;
  customEndDate?: Date;
}

const toNum = (val: string | number | undefined | null): number =>
  typeof val === 'number' ? val : parseFloat(String(val ?? 0));

// ─── RevenueHighlights ────────────────────────────────────────────────────────

interface RevenueHighlightsProps {
  data: { revenueChange?: number; totalRevenue?: number } | undefined;
  detailedTransactions: { bowlingWebResDeposits?: number; laserTagWebResDeposits?: number } | undefined;
  trueRevenue: number;
  calculatedNetRevenue: number;
  bowlingDepositRedemptions: number;
  laserTagDepositRedemptions: number;
}

function RevenueHighlights({
  data,
  detailedTransactions,
  trueRevenue,
  calculatedNetRevenue,
  bowlingDepositRedemptions,
  laserTagDepositRedemptions,
}: RevenueHighlightsProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
      <div className="bg-card/80 backdrop-blur-sm p-6 rounded-xl border border-border shadow-xl transition-all hover:border-primary/20 hover:shadow-primary/5">
        <div className="flex justify-between">
          <div>
            <div className="flex items-center gap-1.5">
              <h3 className="text-sm font-medium text-muted-foreground">True Revenue</h3>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help shrink-0" />
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-[280px] text-xs">
                    <p className="font-semibold">True Revenue = Gross Payments - Event Deposit Redemptions - Refunds/Returns - GC Redemptions</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <p className="text-3xl font-bold mt-2 text-card-foreground">{formatCurrency(trueRevenue)}</p>
          </div>
          <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center">
            <DollarSign className="h-6 w-6 text-primary" />
          </div>
        </div>
        <div className="mt-4 flex items-center">
          <div
            className={`px-2 py-1 rounded-lg text-xs font-semibold flex items-center ${
              isPositiveChange(data?.revenueChange || 0)
                ? "bg-green-500/10 text-green-400"
                : "bg-red-500/10 text-red-400"
            }`}
          >
            {isPositiveChange(data?.revenueChange || 0) ? (
              <ChevronUp className="mr-0.5 h-3 w-3" />
            ) : (
              <ChevronDown className="mr-0.5 h-3 w-3" />
            )}
            {formatPercentage(Math.abs(data?.revenueChange || 0))}
          </div>
          <span className="ml-2 text-xs text-muted-foreground">vs. previous period</span>
        </div>
      </div>

      <div className="bg-card/80 backdrop-blur-sm p-6 rounded-xl border border-border shadow-xl transition-all hover:border-primary/20 hover:shadow-primary/5">
        <div className="flex justify-between">
          <div>
            <div className="flex items-center gap-1.5">
              <h3 className="text-sm font-medium text-muted-foreground">Net Revenue</h3>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help shrink-0" />
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-[280px] text-xs">
                    <p className="font-semibold">Net Revenue = True Revenue - Tips - Service Charges - Auto Gratuity - Taxes - Discounts & Comps</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <p className="text-3xl font-bold mt-2 text-card-foreground">{formatCurrency(calculatedNetRevenue)}</p>
          </div>
          <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center">
            <Wallet className="h-6 w-6 text-primary" />
          </div>
        </div>
        <div className="mt-4 flex items-center">
          <div
            className={`px-2 py-1 rounded-lg text-xs font-semibold flex items-center ${
              calculatedNetRevenue < (data?.totalRevenue || 0)
                ? "bg-amber-500/10 text-amber-400"
                : "bg-green-500/10 text-green-400"
            }`}
          >
            {calculatedNetRevenue < (data?.totalRevenue || 0) ? (
              <ChevronDown className="mr-0.5 h-3 w-3" />
            ) : (
              <ChevronUp className="mr-0.5 h-3 w-3" />
            )}
            {formatPercentage(Math.abs(1 - (calculatedNetRevenue / (data?.totalRevenue || 1))))}
          </div>
          <span className="ml-2 text-xs text-muted-foreground">vs. gross revenue</span>
        </div>
      </div>

      <div className="bg-card/80 backdrop-blur-sm p-6 rounded-xl border border-border shadow-xl transition-all hover:border-primary/20 hover:shadow-primary/5">
        <div className="flex justify-between">
          <div>
            <div className="flex items-center gap-1.5">
              <h3 className="text-sm font-medium text-muted-foreground">Web Res Deposits</h3>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help shrink-0" />
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-[280px] text-xs space-y-1">
                    <p className="font-semibold mb-1">Web Res Deposits = Bowling Web Res + Laser Tag Web Res</p>
                    <p>Total deposits collected through online reservations (bowling and laser tag). These are activated as gift cards in Square when the reservation is made.</p>
                    {(detailedTransactions?.bowlingWebResDeposits || 0) > 0 && <p>Bowling: {formatCurrency(detailedTransactions?.bowlingWebResDeposits || 0)}</p>}
                    {(detailedTransactions?.laserTagWebResDeposits || 0) > 0 && <p>Laser Tag: {formatCurrency(detailedTransactions?.laserTagWebResDeposits || 0)}</p>}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <p className="text-3xl font-bold mt-2 text-card-foreground">{formatCurrency((detailedTransactions?.bowlingWebResDeposits || 0) + (detailedTransactions?.laserTagWebResDeposits || 0))}</p>
          </div>
          <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center">
            <Receipt className="h-6 w-6 text-primary" />
          </div>
        </div>
        <div className="mt-4 flex items-center">
          <span className="text-xs text-muted-foreground">
            {(detailedTransactions?.bowlingWebResDeposits || 0) > 0 && (detailedTransactions?.laserTagWebResDeposits || 0) > 0
              ? `Bowling: ${formatCurrency(detailedTransactions?.bowlingWebResDeposits || 0)} · Laser Tag: ${formatCurrency(detailedTransactions?.laserTagWebResDeposits || 0)}`
              : (detailedTransactions?.bowlingWebResDeposits || 0) > 0
                ? "All from bowling reservations"
                : (detailedTransactions?.laserTagWebResDeposits || 0) > 0
                  ? "All from laser tag reservations"
                  : "No web res deposits in this period"}
          </span>
        </div>
      </div>

      <div className="bg-card/80 backdrop-blur-sm p-6 rounded-xl border border-border shadow-xl transition-all hover:border-primary/20 hover:shadow-primary/5">
        <div className="flex justify-between">
          <div>
            <div className="flex items-center gap-1.5">
              <h3 className="text-sm font-medium text-muted-foreground">Web Res Redemptions</h3>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help shrink-0" />
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-[280px] text-xs space-y-1">
                    <p className="font-semibold mb-1">Web Res Redemptions = Bowling Deposit Redemptions + Laser Tag Deposit Redemptions</p>
                    <p>When a customer checks in, their web reservation deposit (gift card) is redeemed against the final bill. This tracks those redemptions.</p>
                    {bowlingDepositRedemptions > 0 && <p>Bowling: {formatCurrency(bowlingDepositRedemptions)}</p>}
                    {laserTagDepositRedemptions > 0 && <p>Laser Tag: {formatCurrency(laserTagDepositRedemptions)}</p>}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <p className="text-3xl font-bold mt-2 text-card-foreground">{formatCurrency(bowlingDepositRedemptions + laserTagDepositRedemptions)}</p>
          </div>
          <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center">
            <CreditCard className="h-6 w-6 text-primary" />
          </div>
        </div>
        <div className="mt-4 flex items-center">
          <span className="text-xs text-muted-foreground">
            {bowlingDepositRedemptions > 0 && laserTagDepositRedemptions > 0
              ? `Bowling: ${formatCurrency(bowlingDepositRedemptions)} · Laser Tag: ${formatCurrency(laserTagDepositRedemptions)}`
              : bowlingDepositRedemptions > 0
                ? "All from bowling reservations"
                : laserTagDepositRedemptions > 0
                  ? "All from laser tag reservations"
                  : "No web res redemptions in this period"}
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── SummaryStatsCard ─────────────────────────────────────────────────────────

interface SummaryStatsCardProps {
  data: {
    grossPayments?: number;
    depositClearings?: number;
    partywirksDeposits?: number;
    tripleseatDeposits?: number;
    refunds?: number;
    returns?: number;
    giftCardRedemptions?: number;
    totalRevenue?: number;
  } | undefined;
  detailedTransactions: {
    discountsAndComps?: number;
    tips?: number;
    serviceCharges?: number;
    autoGratuity?: number;
    taxes?: number;
    processingFees?: { initialFees?: number; reimbursements?: number; thirdPartyFees?: number; netFees?: number };
    gcRedemptionBreakdown?: { bowlingDepositRedemptions?: number; laserTagDepositRedemptions?: number; giftCardRedemptions?: number };
    intercardRevenue?: number;
    intercardCashRevenue?: number;
    intercardCreditRevenue?: number;
    squareIntercardKioskCash?: number;
    bowlingWebResDeposits?: number;
    laserTagWebResDeposits?: number;
    giftCardSales?: number;
    partywirks?: number;
    tripleseat?: number;
  } | undefined;
  trueRevenue: number;
  calculatedNetRevenue: number;
  bowlingDepositRedemptions: number;
  laserTagDepositRedemptions: number;
}

function SummaryStatsCard({
  data,
  detailedTransactions,
  trueRevenue,
  calculatedNetRevenue,
  bowlingDepositRedemptions,
  laserTagDepositRedemptions,
}: SummaryStatsCardProps) {
  const [depositClearingsExpanded, setDepositClearingsExpanded] = useState(false);
  const [gcRedemptionsExpanded, setGcRedemptionsExpanded] = useState(false);
  const [feesExpanded, setFeesExpanded] = useState(false);
  const [intercardExpanded, setIntercardExpanded] = useState(false);

  const grossPayments = toNum(data?.grossPayments);
  const depositClearings = toNum(data?.depositClearings);
  const partywirksDeposits = toNum(data?.partywirksDeposits);
  const tripleseatDeposits = toNum(data?.tripleseatDeposits);
  const refunds = toNum(data?.refunds);
  const returns = toNum(data?.returns);
  const refundsAndReturns = refunds + returns;
  const giftCardRedemptionsAmount = toNum(data?.giftCardRedemptions);
  const gcBreakdown = detailedTransactions?.gcRedemptionBreakdown;
  const pureGcRedemptions = toNum(gcBreakdown?.giftCardRedemptions);
  const processingFees = detailedTransactions?.processingFees;
  const initialFees = toNum(processingFees?.initialFees);
  const feeReimbursements = toNum(processingFees?.reimbursements);
  const thirdPartyFees = toNum(processingFees?.thirdPartyFees);
  const netProcessingFees = toNum(processingFees?.netFees);
  const intercardRev = toNum(detailedTransactions?.intercardRevenue);
  const intercardCash = toNum(detailedTransactions?.intercardCashRevenue);
  const intercardCredit = toNum(detailedTransactions?.intercardCreditRevenue);
  const squareKioskCash = toNum(detailedTransactions?.squareIntercardKioskCash);
  const kioskCashMatches = Math.abs(squareKioskCash - intercardCash) < 0.01;

  return (
    <div className="bg-gradient-to-br from-primary/20 to-primary/5 backdrop-blur-sm p-6 rounded-xl border border-primary/20 shadow-xl">
      <h2 className="text-xl font-bold mb-6 text-card-foreground">Summary Stats</h2>

      <div className="space-y-5">
        <div className="flex justify-between items-center">
          <span className="text-card-foreground font-semibold">Gross Payments</span>
          <span className="text-card-foreground font-semibold">{formatCurrency(grossPayments)}</span>
        </div>

        <button
          type="button"
          className="flex w-full justify-between items-center cursor-pointer select-none text-left"
          onClick={() => setDepositClearingsExpanded(!depositClearingsExpanded)}
        >
          <span className="flex items-center gap-1.5">
            {depositClearingsExpanded ? (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" />
            ) : (
              <ChevronUp className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0 rotate-90" />
            )}
            <span className="text-muted-foreground">Event Deposit Redemptions</span>
          </span>
          <span className="text-card-foreground font-medium">({formatCurrency(depositClearings)})</span>
        </button>

        {depositClearingsExpanded && (
          <>
            <div className="flex justify-between items-center pl-6">
              <span className="text-muted-foreground text-sm">Partywirks Deposit</span>
              <span className="text-card-foreground font-medium">({formatCurrency(partywirksDeposits)})</span>
            </div>
            <div className="flex justify-between items-center pl-6">
              <span className="text-muted-foreground text-sm">Tripleseat Deposit</span>
              <span className="text-card-foreground font-medium">({formatCurrency(tripleseatDeposits)})</span>
            </div>
          </>
        )}

        <div className="flex justify-between items-center">
          <span className="text-muted-foreground">Refunds + Returns</span>
          <span className="text-card-foreground font-medium">({formatCurrency(refundsAndReturns)})</span>
        </div>

        <button
          type="button"
          className="flex w-full justify-between items-center cursor-pointer select-none text-left"
          onClick={() => setGcRedemptionsExpanded(!gcRedemptionsExpanded)}
        >
          <span className="flex items-center gap-1.5">
            {gcRedemptionsExpanded ? (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" />
            ) : (
              <ChevronUp className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0 rotate-90" />
            )}
            <span className="text-muted-foreground">Gift Card Redemptions</span>
          </span>
          <span className="text-card-foreground font-medium">({formatCurrency(giftCardRedemptionsAmount)})</span>
        </button>

        {gcRedemptionsExpanded && (
          <>
            <div className="flex justify-between items-center pl-6">
              <span className="text-muted-foreground text-sm">Bowling Deposit Redemptions</span>
              <span className="text-card-foreground font-medium">({formatCurrency(bowlingDepositRedemptions)})</span>
            </div>
            <div className="flex justify-between items-center pl-6">
              <span className="text-muted-foreground text-sm">Laser Tag Deposit Redemptions</span>
              <span className="text-card-foreground font-medium">({formatCurrency(laserTagDepositRedemptions)})</span>
            </div>
            <div className="flex justify-between items-center pl-6">
              <span className="text-muted-foreground text-sm">Gift Card Redemptions</span>
              <span className="text-card-foreground font-medium">({formatCurrency(pureGcRedemptions)})</span>
            </div>
          </>
        )}

        <div className="flex justify-between items-center pt-3 border-t border-border">
          <span className="text-card-foreground font-semibold">True Revenue</span>
          <span className="text-card-foreground font-semibold">{formatCurrency(trueRevenue)}</span>
        </div>

        <div className="flex justify-between items-center">
          <span className="text-muted-foreground">Tips</span>
          <span className="text-card-foreground font-medium">({formatCurrency(toNum(detailedTransactions?.tips))})</span>
        </div>

        <div className="flex justify-between items-center">
          <span className="text-muted-foreground">Service Charges</span>
          <span className="text-card-foreground font-medium">({formatCurrency(toNum(detailedTransactions?.serviceCharges))})</span>
        </div>

        <div className="flex justify-between items-center">
          <span className="text-muted-foreground">Auto Gratuity</span>
          <span className="text-card-foreground font-medium">({formatCurrency(toNum(detailedTransactions?.autoGratuity))})</span>
        </div>

        <div className="flex justify-between items-center">
          <span className="text-muted-foreground">Taxes</span>
          <span className="text-card-foreground font-medium">({formatCurrency(toNum(detailedTransactions?.taxes))})</span>
        </div>

        <div className="flex justify-between items-center">
          <span className="text-muted-foreground">Discounts & Comps</span>
          <span className="text-card-foreground font-medium">({formatCurrency(toNum(detailedTransactions?.discountsAndComps))})</span>
        </div>

        <div className="flex justify-between items-center pt-3 border-t border-border">
          <span className="text-card-foreground font-medium">Net Revenue</span>
          <span className="text-card-foreground font-medium">{formatCurrency(calculatedNetRevenue)}</span>
        </div>

        {(initialFees > 0 || netProcessingFees !== 0) && (
          <>
            <button
              type="button"
              className="flex w-full justify-between items-center pt-3 border-t border-border cursor-pointer select-none text-left"
              onClick={() => setFeesExpanded(!feesExpanded)}
            >
              <span className="flex items-center gap-1.5">
                {feesExpanded ? (
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" />
                ) : (
                  <ChevronUp className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0 rotate-90" />
                )}
                <span className="text-muted-foreground">CC Processing Fees</span>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help shrink-0" />
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-[300px] text-xs space-y-1">
                      <p className="font-semibold mb-1">Cost Plus Processing</p>
                      <p>Square charges a standard fee on each transaction, then reimburses the overcharge based on your cost-plus plan.</p>
                      <p className="text-muted-foreground/80 text-[10px] pt-1">Reimbursements may lag 1-2 business days behind initial charges. Monthly totals will be more accurate than daily.</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </span>
              <span className="text-card-foreground font-medium">({formatCurrency(netProcessingFees)})</span>
            </button>

            {feesExpanded && (
              <>
                <div className="flex justify-between items-center pl-6">
                  <span className="text-muted-foreground text-sm">Initial Fees</span>
                  <span className="text-card-foreground font-medium">({formatCurrency(initialFees)})</span>
                </div>
                <div className="flex justify-between items-center pl-6">
                  <span className="text-muted-foreground text-sm">Cost Plus Reimbursements</span>
                  <span className="text-card-foreground font-medium">+{formatCurrency(feeReimbursements)}</span>
                </div>
                {thirdPartyFees > 0 && (
                  <div className="flex justify-between items-center pl-6">
                    <span className="text-muted-foreground text-sm">Third Party Fees</span>
                    <span className="text-card-foreground font-medium">({formatCurrency(thirdPartyFees)})</span>
                  </div>
                )}
              </>
            )}

            <div className="flex justify-between items-center pt-3 border-t border-border">
              <span className="text-card-foreground font-semibold">Net Revenue After Fees</span>
              <span className="text-card-foreground font-semibold">{formatCurrency(calculatedNetRevenue - netProcessingFees)}</span>
            </div>
          </>
        )}

        <div className="flex justify-between items-center pt-3 border-t border-border">
          <span className="text-muted-foreground">Bowling Web Res Deposits</span>
          <span className="text-card-foreground font-medium">{formatCurrency(detailedTransactions?.bowlingWebResDeposits || 0)}</span>
        </div>

        <div className="flex justify-between items-center">
          <span className="text-muted-foreground">Laser Tag Web Res Deposits</span>
          <span className="text-card-foreground font-medium">{formatCurrency(detailedTransactions?.laserTagWebResDeposits || 0)}</span>
        </div>

        <div className="flex justify-between items-center">
          <span className="text-muted-foreground">Gift Card Sales</span>
          <span className="text-card-foreground font-medium">{formatCurrency(detailedTransactions?.giftCardSales || 0)}</span>
        </div>

        <div className="flex justify-between items-center">
          <span className="text-muted-foreground">Partywirks Deposits</span>
          <span className="text-card-foreground font-medium">{formatCurrency(detailedTransactions?.partywirks || 0)}</span>
        </div>

        <div className="flex justify-between items-center">
          <span className="text-muted-foreground">Tripleseat Deposits</span>
          <span className="text-card-foreground font-medium">{formatCurrency(detailedTransactions?.tripleseat || 0)}</span>
        </div>

        <button
          type="button"
          className="flex w-full justify-between items-center cursor-pointer select-none text-left"
          onClick={() => setIntercardExpanded(!intercardExpanded)}
        >
          <span className="flex items-center gap-1.5">
            {intercardExpanded ? (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" />
            ) : (
              <ChevronUp className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0 rotate-90" />
            )}
            <span className="text-muted-foreground">Intercard Revenue</span>
          </span>
          <span className="text-card-foreground font-medium">{formatCurrency(intercardRev)}</span>
        </button>

        {intercardExpanded && (
          <>
            <div className="flex justify-between items-center pl-6">
              <div className="flex items-center gap-1.5">
                <span className="text-muted-foreground text-sm">Cash Revenue</span>
                {(intercardCash > 0 || squareKioskCash > 0) && (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        {kioskCashMatches ? (
                          <Check className="h-3.5 w-3.5 text-green-400 shrink-0" />
                        ) : (
                          <X className="h-3.5 w-3.5 text-red-400 shrink-0" />
                        )}
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="max-w-[280px] text-xs space-y-1">
                        <p className="font-semibold mb-1">{kioskCashMatches ? "Amounts match" : "Amounts do not match"}</p>
                        <p>Square Kiosk Cash: {formatCurrency(squareKioskCash)}</p>
                        <p>Intercard API Cash: {formatCurrency(intercardCash)}</p>
                        <p className="text-muted-foreground/80 text-[10px] pt-1">Square "Intercard Kiosk Cash" items are excluded from gross payments to prevent double-counting.</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
              </div>
              <span className="text-card-foreground font-medium">{formatCurrency(intercardCash)}</span>
            </div>
            <div className="flex justify-between items-center pl-6">
              <span className="text-muted-foreground text-sm">Credit Card Revenue</span>
              <span className="text-card-foreground font-medium">{formatCurrency(intercardCredit)}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── StatsSummary (main export) ───────────────────────────────────────────────

export default function StatsSummary({ dateRange, customStartDate, customEndDate }: StatsSummaryProps) {
  const { data, isLoading } = useQuery({
    queryKey: ['/api/summary', dateRange, customStartDate?.toISOString(), customEndDate?.toISOString()],
    queryFn: () => fetchDailySummary(dateRange, customStartDate, customEndDate),
    retry: 1,
    retryDelay: 1000,
    refetchInterval: false,
  });

  const { data: detailedTransactions, isLoading: isDetailedLoading } = useQuery({
    queryKey: ['/api/detailed-transactions', dateRange, customStartDate?.toISOString(), customEndDate?.toISOString()],
    queryFn: () => fetchDetailedTransactions(dateRange, customStartDate, customEndDate),
    retry: 1,
    retryDelay: 1000,
    refetchInterval: false,
  });

  if (isLoading || isDetailedLoading) {
    return (
      <div className="mt-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <Skeleton className="h-36 w-full rounded-xl" />
        <Skeleton className="h-36 w-full rounded-xl" />
        <Skeleton className="h-36 w-full rounded-xl" />
        <Skeleton className="h-36 w-full rounded-xl" />
        <Skeleton className="h-80 w-full rounded-xl md:col-span-2 lg:col-span-4" />
      </div>
    );
  }

  const totalRevenue = toNum(data?.totalRevenue);
  const trueRevenue = totalRevenue;
  const tips = toNum(detailedTransactions?.tips);
  const serviceCharges = toNum(detailedTransactions?.serviceCharges);
  const autoGratuity = toNum(detailedTransactions?.autoGratuity);
  const taxes = toNum(detailedTransactions?.taxes);
  const discounts = toNum(detailedTransactions?.discountsAndComps);
  const calculatedNetRevenue = trueRevenue - discounts - tips - serviceCharges - autoGratuity - taxes;
  const gcBreakdown = detailedTransactions?.gcRedemptionBreakdown;
  const bowlingDepositRedemptions = toNum(gcBreakdown?.bowlingDepositRedemptions);
  const laserTagDepositRedemptions = toNum(gcBreakdown?.laserTagDepositRedemptions);

  return (
    <div className="mt-4 space-y-6">
      <RevenueHighlights
        data={data}
        detailedTransactions={detailedTransactions}
        trueRevenue={trueRevenue}
        calculatedNetRevenue={calculatedNetRevenue}
        bowlingDepositRedemptions={bowlingDepositRedemptions}
        laserTagDepositRedemptions={laserTagDepositRedemptions}
      />

      {/* Hourly Revenue Chart */}
      <div className="bg-card/80 backdrop-blur-sm p-6 rounded-xl border border-border shadow-xl">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold text-card-foreground">Hourly Revenue</h2>
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <TrendingUp className="h-4 w-4 text-primary" />
            <span>Today's pattern</span>
          </div>
        </div>
        <SimpleBarChart
          dateRange={dateRange}
          customStartDate={customStartDate}
          customEndDate={customEndDate}
        />
      </div>

      {/* Summary Section */}
      <div className="grid grid-cols-1 md:grid-cols-1 gap-6">
        <SummaryStatsCard
          data={data}
          detailedTransactions={detailedTransactions}
          trueRevenue={trueRevenue}
          calculatedNetRevenue={calculatedNetRevenue}
          bowlingDepositRedemptions={bowlingDepositRedemptions}
          laserTagDepositRedemptions={laserTagDepositRedemptions}
        />
      </div>
    </div>
  );
}
