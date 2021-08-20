import { Currency, Fraction, Token, TradeType, WETH9 } from '@uniswap/sdk-core';
import {
  FeeAmount,
  MethodParameters,
  Pool,
  Route,
  SwapRouter,
  Trade,
} from '@uniswap/v3-sdk';
import { BigNumber, providers } from 'ethers';
import _ from 'lodash';
import { FixedReverseHeap } from 'mnemonist';
import { IMulticallProvider } from '../../providers';
import { IGasPriceProvider } from '../../providers/gas-price-provider';
import { IPoolProvider, PoolAccessor } from '../../providers/pool-provider';
import {
  IQuoteProvider,
  RouteWithQuotes,
} from '../../providers/quote-provider';
import {
  ISubgraphProvider,
  printSubgraphPool,
  SubgraphPool,
} from '../../providers/subgraph-provider';
import { ITokenListProvider } from '../../providers/token-list-provider';
import {
  DAI,
  ITokenProvider,
  USDC,
  USDT,
  WBTC,
} from '../../providers/token-provider';
import { CurrencyAmount, parseFeeAmount } from '../../util/amounts';
import { ChainId } from '../../util/chains';
import { log } from '../../util/log';
import { metric, MetricLoggerUnit } from '../../util/metric';
import { routeAmountsToString, routeToString } from '../../util/routes';
import {
  IRouter,
  RouteAmount,
  RouteSOR,
  SwapConfig,
  SwapRoute,
} from '../router';
import { RouteWithValidQuote } from './entities/route-with-valid-quote';
import { GasModel, IGasModelFactory } from './gas-models/gas-model';

export type AlphaRouterParams = {
  chainId: ChainId;
  provider: providers.BaseProvider;
  multicall2Provider: IMulticallProvider;
  subgraphProvider: ISubgraphProvider;
  poolProvider: IPoolProvider;
  quoteProvider: IQuoteProvider;
  tokenProvider: ITokenProvider;
  gasPriceProvider: IGasPriceProvider;
  gasModelFactory: IGasModelFactory;
  blockedTokenListProvider?: ITokenListProvider;
};

export type AlphaRouterConfig = {
  blockNumber?: number;
  topN: number;
  topNTokenInOut: number;
  topNSecondHop: number;
  topNWithEachBaseToken: number;
  topNWithBaseToken: number;
  topNWithBaseTokenInSet: boolean;
  maxSwapsPerPath: number;
  maxSplits: number;
  distributionPercent: number;
};

export const DEFAULT_CONFIG: AlphaRouterConfig = {
  topN: 4,
  topNTokenInOut: 4,
  topNSecondHop: 2,
  topNWithEachBaseToken: 2,
  topNWithBaseToken: 10,
  topNWithBaseTokenInSet: false,
  maxSwapsPerPath: 3,
  maxSplits: 3,
  distributionPercent: 5,
};

type PoolsBySelection = {
  topByBaseWithTokenIn: SubgraphPool[];
  topByBaseWithTokenOut: SubgraphPool[];
  top2DirectSwapPool: SubgraphPool[];
  top2EthQuoteTokenPool: SubgraphPool[];
  topByTVL: SubgraphPool[];
  topByTVLUsingTokenIn: SubgraphPool[];
  topByTVLUsingTokenOut: SubgraphPool[];
  topByTVLUsingTokenInSecondHops: SubgraphPool[];
  topByTVLUsingTokenOutSecondHops: SubgraphPool[];
};

export class AlphaRouter implements IRouter<AlphaRouterConfig> {
  protected chainId: ChainId;
  protected provider: providers.BaseProvider;
  protected multicall2Provider: IMulticallProvider;
  protected subgraphProvider: ISubgraphProvider;
  protected poolProvider: IPoolProvider;
  protected quoteProvider: IQuoteProvider;
  protected tokenProvider: ITokenProvider;
  protected gasPriceProvider: IGasPriceProvider;
  protected gasModelFactory: IGasModelFactory;
  protected blockedTokenListProvider?: ITokenListProvider;

  constructor({
    chainId,
    provider,
    multicall2Provider,
    poolProvider,
    quoteProvider,
    tokenProvider,
    blockedTokenListProvider,
    subgraphProvider,
    gasPriceProvider,
    gasModelFactory,
  }: AlphaRouterParams) {
    this.chainId = chainId;
    this.provider = provider;
    this.multicall2Provider = multicall2Provider;
    this.poolProvider = poolProvider;
    this.quoteProvider = quoteProvider;
    this.blockedTokenListProvider = blockedTokenListProvider;
    this.tokenProvider = tokenProvider;
    this.subgraphProvider = subgraphProvider;
    this.gasPriceProvider = gasPriceProvider;
    this.gasModelFactory = gasModelFactory;
  }

  public async routeExactIn(
    currencyIn: Currency,
    currencyOut: Currency,
    amountIn: CurrencyAmount,
    swapConfig: SwapConfig,
    routingConfig = DEFAULT_CONFIG
  ): Promise<SwapRoute<TradeType.EXACT_INPUT> | null> {
    return this.route<TradeType.EXACT_INPUT>(
      currencyIn,
      currencyOut,
      amountIn,
      TradeType.EXACT_INPUT,
      swapConfig,
      routingConfig
    );
  }

  public async routeExactOut(
    currencyIn: Currency,
    currencyOut: Currency,
    amountOut: CurrencyAmount,
    swapConfig: SwapConfig,
    routingConfig = DEFAULT_CONFIG
  ): Promise<SwapRoute<TradeType.EXACT_OUTPUT> | null> {
    return this.route<TradeType.EXACT_OUTPUT>(
      currencyIn,
      currencyOut,
      amountOut,
      TradeType.EXACT_OUTPUT,
      swapConfig,
      routingConfig
    );
  }

  private async route<TTradeType extends TradeType>(
    currencyIn: Currency,
    currencyOut: Currency,
    amount: CurrencyAmount,
    swapType: TTradeType,
    swapConfig: SwapConfig,
    routingConfig = DEFAULT_CONFIG
  ): Promise<SwapRoute<TTradeType> | null> {
    const blockNumber =
      routingConfig.blockNumber ?? this.provider.getBlockNumber();
    const tokenIn = currencyIn.wrapped;
    const tokenOut = currencyOut.wrapped;

    const { poolAccessor, poolsBySelection } = await this.getPoolsToConsider(
      tokenIn,
      tokenOut,
      swapType,
      routingConfig
    );
    const pools = poolAccessor.getAllPools();

    const beforeGas = Date.now();
    const { gasPriceWei } = await this.gasPriceProvider.getGasPrice();

    metric.putMetric(
      'GasPriceLoad',
      Date.now() - beforeGas,
      MetricLoggerUnit.Milliseconds
    );

    const quoteToken = swapType == TradeType.EXACT_INPUT ? tokenOut : tokenIn;

    const gasModel = this.gasModelFactory.buildGasModel(
      this.chainId,
      gasPriceWei,
      poolAccessor,
      quoteToken
    );

    const { maxSwapsPerPath } = routingConfig;
    const routes = this.computeAllRoutes(
      tokenIn,
      tokenOut,
      pools,
      maxSwapsPerPath
    );

    if (routes.length == 0) {
      return null;
    }

    const [percents, amounts] = this.getAmountDistribution(
      amount,
      routingConfig
    );

    const quoteFn =
      swapType == TradeType.EXACT_INPUT
        ? this.quoteProvider.getQuotesManyExactIn.bind(this.quoteProvider)
        : this.quoteProvider.getQuotesManyExactOut.bind(this.quoteProvider);

    const beforeQuotes = Date.now();
    const { routesWithQuotes, blockNumber: blockNumberBN } = await quoteFn(
      amounts,
      routes,
      { blockNumber }
    );

    metric.putMetric(
      'QuotesLoad',
      Date.now() - beforeQuotes,
      MetricLoggerUnit.Milliseconds
    );

    metric.putMetric(
      'QuotesFetched',
      _(routesWithQuotes)
        .map(([, quotes]) => quotes.length)
        .sum(),
      MetricLoggerUnit.Count
    );

    const beforeBestSwap = Date.now();
    const swapRouteRaw = this.getBestSwapRoute(
      amount,
      percents,
      routesWithQuotes,
      quoteToken,
      swapType,
      gasModel,
      routingConfig
    );

    if (!swapRouteRaw) {
      return null;
    }

    const {
      quote,
      quoteGasAdjusted,
      estimatedGasUsed,
      routeAmounts,
      estimatedGasUsedQuoteToken,
      estimatedGasUsedUSD,
    } = swapRouteRaw;

    const trade = this.buildTrade<TTradeType>(
      currencyIn,
      currencyOut,
      swapType,
      routeAmounts
    );

    let methodParameters: MethodParameters | undefined;

    if (swapConfig) {
      methodParameters = this.buildMethodParameters(trade, swapConfig);
    }

    metric.putMetric(
      'FindBestSwapRoute',
      Date.now() - beforeBestSwap,
      MetricLoggerUnit.Milliseconds
    );

    this.emitPoolSelectionMetrics(swapRouteRaw, poolsBySelection);

    return {
      quote,
      quoteGasAdjusted,
      estimatedGasUsed,
      estimatedGasUsedQuoteToken,
      estimatedGasUsedUSD,
      gasPriceWei,
      routeAmounts,
      trade,
      methodParameters,
      blockNumber: blockNumberBN,
    };
  }

  private getBestSwapRoute(
    amount: CurrencyAmount,
    percents: number[],
    routesWithQuotes: RouteWithQuotes[],
    quoteToken: Token,
    routeType: TradeType,
    gasModel: GasModel,
    routingConfig: AlphaRouterConfig
  ): {
    quote: CurrencyAmount;
    quoteGasAdjusted: CurrencyAmount;
    estimatedGasUsed: BigNumber;
    estimatedGasUsedUSD: CurrencyAmount;
    estimatedGasUsedQuoteToken: CurrencyAmount;
    routeAmounts: RouteAmount[];
  } | null {
    const now = Date.now();

    // Build a map of percentage of the input to list of valid quotes.
    // Quotes can be null for a variety of reasons (not enough liquidity etc), so we drop them here too.
    const percentToQuotes: { [percent: number]: RouteWithValidQuote[] } = {};
    for (const routeWithQuote of routesWithQuotes) {
      const [route, quotes] = routeWithQuote;

      for (let i = 0; i < quotes.length; i++) {
        const percent = percents[i]!;
        const amountQuote = quotes[i]!;
        const {
          quote,
          amount,
          sqrtPriceX96AfterList,
          initializedTicksCrossedList,
          gasEstimate,
        } = amountQuote;

        if (
          !quote ||
          !sqrtPriceX96AfterList ||
          !initializedTicksCrossedList ||
          !gasEstimate
        ) {
          log.debug(
            {
              route: routeToString(route),
              amountQuote,
            },
            'Dropping a null quote for route.'
          );
          continue;
        }

        if (!percentToQuotes[percent]) {
          percentToQuotes[percent] = [];
        }

        const routeWithValidQuote = new RouteWithValidQuote({
          route,
          rawQuote: quote,
          amount,
          percent,
          sqrtPriceX96AfterList,
          initializedTicksCrossedList,
          quoterGasEstimate: gasEstimate,
          gasModel,
          quoteToken,
          tradeType: routeType,
        });

        percentToQuotes[percent]!.push(routeWithValidQuote);
      }
    }

    metric.putMetric(
      'BuildRouteWithValidQuoteObjects',
      Date.now() - now,
      MetricLoggerUnit.Milliseconds
    );

    // Given all the valid quotes for each percentage find the optimal route.
    const swapRoute = this.getBestSwapRouteBy(
      routeType,
      percentToQuotes,
      percents,
      (rq: RouteWithValidQuote) => rq.quoteAdjustedForGas,
      routingConfig
    );

    // It is possible we were unable to find any valid route given the quotes.
    if (!swapRoute) {
      return null;
    }

    // Due to potential loss of precision when taking percentages of the input it is possible that the sum of the amounts of each
    // route of our optimal quote may not add up exactly to exactIn or exactOut.
    //
    // We check this here, and if there is a mismatch
    // add the missing amount to a random route. The missing amount size should be neglible so the quote should still be highly accurate.
    const { routeAmounts } = swapRoute;
    const totalAmount = _.reduce(
      routeAmounts,
      (total, routeAmount) => total.add(routeAmount.amount),
      CurrencyAmount.fromRawAmount(routeAmounts[0]!.amount.currency, 0)
    );

    const missingAmount = amount.subtract(totalAmount);
    if (missingAmount.greaterThan(0)) {
      log.info(
        {
          missingAmount: missingAmount.quotient.toString(),
        },
        `Optimal route's amounts did not equal exactIn/exactOut total. Adding missing amount to last route in array.`
      );

      routeAmounts[routeAmounts.length - 1]!.amount =
        routeAmounts[routeAmounts.length - 1]!.amount.add(missingAmount);
    }

    log.info(
      {
        routes: routeAmountsToString(swapRoute.routeAmounts),
        numSplits: swapRoute.routeAmounts.length,
        amount: amount.toExact(),
        quote: swapRoute.quote.toExact(),
        quoteGasAdjusted: swapRoute.quoteGasAdjusted.toFixed(2),
        estimatedGasUSD: swapRoute.estimatedGasUsedUSD.toFixed(2),
        estimatedGasToken: swapRoute.estimatedGasUsedQuoteToken.toFixed(2),
      },
      `Found best swap route. ${swapRoute.routeAmounts.length} split.`
    );

    return swapRoute;
  }

  private getBestSwapRouteBy(
    routeType: TradeType,
    percentToQuotes: { [percent: number]: RouteWithValidQuote[] },
    percents: number[],
    by: (routeQuote: RouteWithValidQuote) => CurrencyAmount,
    routingConfig: AlphaRouterConfig
  ):
    | {
        quote: CurrencyAmount;
        quoteGasAdjusted: CurrencyAmount;
        estimatedGasUsed: BigNumber;
        estimatedGasUsedUSD: CurrencyAmount;
        estimatedGasUsedQuoteToken: CurrencyAmount;
        routeAmounts: RouteAmount[];
      }
    | undefined {
    // Build a map of percentage to sorted list of quotes, with the biggest quote being first in the list.
    const percentToSortedQuotes = _.mapValues(
      percentToQuotes,
      (routeQuotes: RouteWithValidQuote[]) => {
        return routeQuotes.sort((routeQuoteA, routeQuoteB) => {
          if (routeType == TradeType.EXACT_INPUT) {
            return by(routeQuoteA).greaterThan(by(routeQuoteB)) ? -1 : 1;
          } else {
            return by(routeQuoteA).lessThan(by(routeQuoteB)) ? -1 : 1;
          }
        });
      }
    );

    // We do not allow pools to be re-used across split routes, as swapping through a pool changes the pools state.
    // Given a list of used routes, this function finds the first route in the list of candidate routes that does not re-use an already used pool.
    const findFirstRouteNotUsingUsedPools = (
      usedRoutes: RouteSOR[],
      candidateRouteQuotes: RouteWithValidQuote[]
    ): RouteWithValidQuote | null => {
      const getPoolAddress = (pool: Pool) => {
        return this.poolProvider.getPoolAddress(
          pool.token0,
          pool.token1,
          pool.fee
        ).poolAddress;
      };

      const poolAddressSet = new Set();
      const usedPoolAddresses = _(usedRoutes)
        .flatMap((r) => r.pools)
        .map(getPoolAddress)
        .value();

      for (let poolAddress of usedPoolAddresses) {
        poolAddressSet.add(poolAddress);
      }

      for (const routeQuote of candidateRouteQuotes) {
        const {
          route: { pools },
        } = routeQuote;
        if (pools.some((pool) => poolAddressSet.has(getPoolAddress(pool)))) {
          continue;
        }

        return routeQuote;
      }

      return null;
    };

    if (!percentToSortedQuotes[100]) {
      log.info(
        {
          percentToSortedQuotes: _.mapValues(
            percentToSortedQuotes,
            (p) => p.length
          ),
        },
        'Did not find a valid route without any splits.'
      );
      return undefined;
    }

    // Start with our first best swap as being the quote where we send 100% of token through a single route.
    let bestQuote = by(percentToSortedQuotes[100][0]!);
    let bestSwap: RouteWithValidQuote[] = [percentToSortedQuotes[100][0]!];

    log.info(
      {
        top: _.map(
          percentToSortedQuotes[100].slice(0, 5),
          (routeWithValidQuote) => {
            return `${routeWithValidQuote.quoteAdjustedForGas.toFixed()} [NoGas: ${routeWithValidQuote.quote.toFixed()}] [EstGas: ${
              routeWithValidQuote.gasEstimate
            }] [TicksCrossed: ${
              routeWithValidQuote.initializedTicksCrossedList
            }]: ${routeToString(routeWithValidQuote.route)}`;
          }
        ),
      },
      'Top 5 with 1 split'
    );

    const quoteCompFn =
      routeType == TradeType.EXACT_INPUT
        ? (a: CurrencyAmount, b: CurrencyAmount) => a.greaterThan(b)
        : (a: CurrencyAmount, b: CurrencyAmount) => a.lessThan(b);

    let splits = 2;

    while (splits <= routingConfig.maxSplits) {
      if (splits == 2) {
        // We track the top 5 best options we find for logging/debugging.
        const bestTwoSplits = new FixedReverseHeap<{
          quote: CurrencyAmount;
          routes: RouteWithValidQuote[];
        }>(
          Array,
          (a, b) => {
            return quoteCompFn(a.quote, b.quote) ? -1 : 1;
          },
          5
        );

        const split2Now = Date.now();
        for (let i = percents.length - 1; i >= 0; i--) {
          const percentA = percents[i]!;

          // At some point the amount * percentage is so small that the quoter is unable to get
          // a quote. In this case there could be no quotes for that percentage.
          if (!percentToSortedQuotes[percentA]) {
            continue;
          }

          // Get the best quote for the current percentage we are considering.
          const routeWithQuoteA = percentToSortedQuotes[percentA]![0]!;
          const { route: routeA } = routeWithQuoteA;
          const quoteA = by(routeWithQuoteA);

          // Get all the quotes for complimentary percentage to the current percentage.
          const percentB = 100 - percentA;
          const candidateRoutesB = percentToSortedQuotes[percentB]!;

          if (!candidateRoutesB) {
            continue;
          }

          // Find the best route in the complimentary percentage that doesn't re-use a pool already
          // used in the best route for the current percentage.
          const routeWithQuoteB = findFirstRouteNotUsingUsedPools(
            [routeA],
            candidateRoutesB
          );

          if (!routeWithQuoteB) {
            continue;
          }

          const newQuote = quoteA.add(by(routeWithQuoteB));

          bestTwoSplits.push({
            quote: newQuote,
            routes: [routeWithQuoteA, routeWithQuoteB],
          });

          if (quoteCompFn(newQuote, bestQuote)) {
            bestQuote = newQuote;
            bestSwap = [routeWithQuoteA, routeWithQuoteB];
          }
        }

        log.info(
          {
            top5TwoSplits: _.map(
              Array.from(bestTwoSplits.consume()),
              (q) =>
                `${q.quote.toExact()} (${_(q.routes)
                  .map((r) => r.toString())
                  .join(', ')})`
            ),
          },
          'Top 5 with 2 splits'
        );

        metric.putMetric(
          'Split2Done',
          Date.now() - split2Now,
          MetricLoggerUnit.Milliseconds
        );
      }

      // If we didn't find a better route with 2 splits, we won't find one with 3 splits.
      // Only continue if we managed to find a better route using 2 splits.
      if (splits == 3 && bestSwap.length < 2) {
        log.info(
          'Did not improve on route with 2 splits. Not checking 3 splits.'
        );
        const split3Now = Date.now();
        metric.putMetric(
          'Split3Done',
          Date.now() - split3Now,
          MetricLoggerUnit.Milliseconds
        );
      }

      if (splits == 3 && bestSwap.length == 2) {
        const split3Now = Date.now();
        for (let i = percents.length - 1; i >= 0; i--) {
          // For our current percentage find the best route.
          const percentA = percents[i]!;
          const routeWithQuoteA = percentToSortedQuotes[percentA]![0]!;
          const { route: routeA } = routeWithQuoteA;
          const quoteA = by(routeWithQuoteA);

          const remainingPercent = 100 - percentA;

          // For the complimentary percentage, we now look for the best combination of two routes
          // that makes up the missing percentage, again ensuring we don't re-use pools.
          for (let j = i - 1; j >= 0; j--) {
            const percentB = percents[j]!;
            const candidateRoutesB = percentToSortedQuotes[percentB]!;

            const routeWithQuoteB = findFirstRouteNotUsingUsedPools(
              [routeA],
              candidateRoutesB
            );

            if (!routeWithQuoteB) {
              continue;
            }

            const { route: routeB } = routeWithQuoteB;
            const quoteB = by(routeWithQuoteB);
            const percentC = remainingPercent - percentB;

            const candidateRoutesC = percentToSortedQuotes[percentC]!;

            if (!candidateRoutesC) {
              continue;
            }

            const routeWithQuoteC = findFirstRouteNotUsingUsedPools(
              [routeA, routeB],
              candidateRoutesC
            );

            if (!routeWithQuoteC) {
              continue;
            }

            const quoteC = by(routeWithQuoteC);

            const newQuote = quoteA.add(quoteB).add(quoteC);

            if (quoteCompFn(newQuote, bestQuote)) {
              bestQuote = newQuote;
              bestSwap = [routeWithQuoteA, routeWithQuoteB, routeWithQuoteC];
            }
          }
        }

        metric.putMetric(
          'Split3Done',
          Date.now() - split3Now,
          MetricLoggerUnit.Milliseconds
        );
      }

      if (splits == 4) {
        throw new Error('Four splits is not supported');
      }

      splits += 1;
    }

    const sum = (currencyAmounts: CurrencyAmount[]): CurrencyAmount => {
      let sum = currencyAmounts[0]!;
      for (let i = 1; i < currencyAmounts.length; i++) {
        sum = sum.add(currencyAmounts[i]!);
      }
      return sum;
    };

    const postSplitNow = Date.now();

    const quoteGasAdjusted = sum(
      _.map(
        bestSwap,
        (routeWithValidQuote) => routeWithValidQuote.quoteAdjustedForGas
      )
    );

    const estimatedGasUsed = _(bestSwap)
      .map((routeWithValidQuote) => routeWithValidQuote.gasEstimate)
      .reduce(
        (sum, routeWithValidQuote) => sum.add(routeWithValidQuote),
        BigNumber.from(0)
      );

    const estimatedGasUsedUSD = sum(
      _.map(bestSwap, (routeWithValidQuote) => routeWithValidQuote.gasCostInUSD)
    );

    const estimatedGasUsedQuoteToken = sum(
      _.map(
        bestSwap,
        (routeWithValidQuote) => routeWithValidQuote.gasCostInToken
      )
    );

    const quote = sum(
      _.map(bestSwap, (routeWithValidQuote) => routeWithValidQuote.quote)
    );

    const routeAmounts = _.map<RouteWithValidQuote, RouteAmount>(
      bestSwap,
      (rq: RouteWithValidQuote) => {
        return {
          route: rq.route,
          amount: rq.amount,
          quote: rq.quote,
          quoteGasAdjusted: rq.quoteAdjustedForGas,
          percentage: rq.percent,
          estimatedGasUsed: rq.gasEstimate,
          estimatedGasUsedQuoteToken: rq.gasCostInToken,
          estimatedGasUsedUSD: rq.gasCostInUSD,
        };
      }
    ).sort((routeAmountA, routeAmountB) =>
      routeAmountB.amount.greaterThan(routeAmountA.amount) ? 1 : -1
    );

    metric.putMetric(
      'PostSplitDone',
      Date.now() - postSplitNow,
      MetricLoggerUnit.Milliseconds
    );

    this.emitGasModelLog(bestSwap);

    return {
      quote,
      quoteGasAdjusted,
      estimatedGasUsed,
      estimatedGasUsedUSD,
      estimatedGasUsedQuoteToken,
      routeAmounts,
    };
  }

  // Note multiplications here can result in a loss of precision in the amounts (e.g. taking 50% of 101)
  // This is reconcilled at the end of the algorithm by adding any lost precision to one of
  // the splits in the route.
  private getAmountDistribution(
    amount: CurrencyAmount,
    routingConfig: AlphaRouterConfig
  ): [number[], CurrencyAmount[]] {
    const { distributionPercent } = routingConfig;
    let percents = [];
    let amounts = [];

    for (let i = 1; i <= 100 / distributionPercent; i++) {
      percents.push(i * distributionPercent);
      amounts.push(amount.multiply(new Fraction(i * distributionPercent, 100)));
    }

    return [percents, amounts];
  }

  private async getPoolsToConsider(
    tokenIn: Token,
    tokenOut: Token,
    routeType: TradeType,
    routingConfig: AlphaRouterConfig
  ): Promise<{
    poolAccessor: PoolAccessor;
    poolsBySelection: PoolsBySelection;
  }> {
    const {
      blockNumber,
      topN,
      topNTokenInOut,
      topNSecondHop,
      topNWithEachBaseToken,
      topNWithBaseTokenInSet,
      topNWithBaseToken,
    } = routingConfig;
    const tokenInAddress = tokenIn.address.toLowerCase();
    const tokenOutAddress = tokenOut.address.toLowerCase();

    const beforeSubgraphPools = Date.now();

    const allPoolsRaw = await this.subgraphProvider.getPools({ blockNumber });

    const allPools = _.map(allPoolsRaw, (pool) => {
      return {
        ...pool,
        token0: {
          ...pool.token0,
          id: pool.token0.id.toLowerCase(),
        },
        token1: {
          ...pool.token1,
          id: pool.token1.id.toLowerCase(),
        },
      };
    });

    metric.putMetric(
      'SubgraphPoolsLoad',
      Date.now() - beforeSubgraphPools,
      MetricLoggerUnit.Milliseconds
    );

    // Only consider pools where neither tokens are in the blocked token list.
    const subgraphPoolsSorted = _(allPools)
      .filter((pool) => {
        if (!this.blockedTokenListProvider) {
          return true;
        }

        return (
          !this.blockedTokenListProvider.getTokenByAddress(pool.token0.id) &&
          !this.blockedTokenListProvider.getTokenByAddress(pool.token1.id)
        );
      })
      .sortBy((tokenListPool) => -tokenListPool.totalValueLockedUSDFloat)
      .value();

    const poolAddressesSoFar = new Set<string>();
    const addToAddressSet = (pools: SubgraphPool[]) => {
      _(pools)
        .map((pool) => pool.id)
        .forEach((poolAddress) => poolAddressesSoFar.add(poolAddress));
    };

    const baseTokens = [USDC, USDT, WBTC, DAI, WETH9[1]!];

    const topByBaseWithTokenIn = _(baseTokens)
      .flatMap((token: Token) => {
        return _(subgraphPoolsSorted)
          .filter((subgraphPool) => {
            const tokenAddress = token.address.toLowerCase();
            return (
              (subgraphPool.token0.id == tokenAddress &&
                subgraphPool.token1.id == tokenInAddress) ||
              (subgraphPool.token1.id == tokenAddress &&
                subgraphPool.token0.id == tokenInAddress)
            );
          })
          .sortBy((tokenListPool) => -tokenListPool.totalValueLockedUSDFloat)
          .slice(0, topNWithEachBaseToken)
          .value();
      })
      .sortBy((tokenListPool) => -tokenListPool.totalValueLockedUSDFloat)
      .slice(0, topNWithBaseToken)
      .value();

    const topByBaseWithTokenOut = _(baseTokens)
      .flatMap((token: Token) => {
        return _(subgraphPoolsSorted)
          .filter((subgraphPool) => {
            const tokenAddress = token.address.toLowerCase();
            return (
              (subgraphPool.token0.id == tokenAddress &&
                subgraphPool.token1.id == tokenOutAddress) ||
              (subgraphPool.token1.id == tokenAddress &&
                subgraphPool.token0.id == tokenOutAddress)
            );
          })
          .sortBy((tokenListPool) => -tokenListPool.totalValueLockedUSDFloat)
          .slice(0, topNWithEachBaseToken)
          .value();
      })
      .sortBy((tokenListPool) => -tokenListPool.totalValueLockedUSDFloat)
      .slice(0, topNWithBaseToken)
      .value();

    if (topNWithBaseTokenInSet) {
      addToAddressSet(topByBaseWithTokenIn);
      addToAddressSet(topByBaseWithTokenOut);
    }

    const top2DirectSwapPool = _(subgraphPoolsSorted)
      .filter((subgraphPool) => {
        return (
          !poolAddressesSoFar.has(subgraphPool.id) &&
          ((subgraphPool.token0.id == tokenInAddress &&
            subgraphPool.token1.id == tokenOutAddress) ||
            (subgraphPool.token1.id == tokenInAddress &&
              subgraphPool.token0.id == tokenOutAddress))
        );
      })
      .slice(0, 2)
      .value();

    addToAddressSet(top2DirectSwapPool);

    const wethAddress = WETH9[1]!.address;

    // Main reason we need this is for gas estimates, only needed if token out is not ETH.
    // We don't check the seen address set because if we've already added pools for getting ETH quotes
    // theres no need to add more.
    let top2EthQuoteTokenPool: SubgraphPool[] = [];
    if (
      tokenOut.symbol != 'WETH' &&
      tokenOut.symbol != 'WETH9' &&
      tokenOut.symbol != 'ETH'
    ) {
      top2EthQuoteTokenPool = _(subgraphPoolsSorted)
        .filter((subgraphPool) => {
          if (routeType == TradeType.EXACT_INPUT) {
            return (
              (subgraphPool.token0.id == wethAddress &&
                subgraphPool.token1.id == tokenOutAddress) ||
              (subgraphPool.token1.id == wethAddress &&
                subgraphPool.token0.id == tokenOutAddress)
            );
          } else {
            return (
              (subgraphPool.token0.symbol == wethAddress &&
                subgraphPool.token1.symbol == tokenIn.symbol) ||
              (subgraphPool.token1.symbol == wethAddress &&
                subgraphPool.token0.symbol == tokenIn.symbol)
            );
          }
        })
        .slice(0, 1)
        .value();
    }

    addToAddressSet(top2EthQuoteTokenPool);

    const topByTVL = _(subgraphPoolsSorted)
      .filter((subgraphPool) => {
        return !poolAddressesSoFar.has(subgraphPool.id);
      })
      .slice(0, topN)
      .value();

    addToAddressSet(topByTVL);

    const topByTVLUsingTokenIn = _(subgraphPoolsSorted)
      .filter((subgraphPool) => {
        return (
          !poolAddressesSoFar.has(subgraphPool.id) &&
          (subgraphPool.token0.id == tokenInAddress ||
            subgraphPool.token1.id == tokenInAddress)
        );
      })
      .slice(0, topNTokenInOut)
      .value();

    addToAddressSet(topByTVLUsingTokenIn);

    const topByTVLUsingTokenOut = _(subgraphPoolsSorted)
      .filter((subgraphPool) => {
        return (
          !poolAddressesSoFar.has(subgraphPool.id) &&
          (subgraphPool.token0.id == tokenOutAddress ||
            subgraphPool.token1.id == tokenOutAddress)
        );
      })
      .slice(0, topNTokenInOut)
      .value();

    addToAddressSet(topByTVLUsingTokenOut);

    const topByTVLUsingTokenInSecondHops = _(topByTVLUsingTokenIn)
      .map((subgraphPool) => {
        return tokenInAddress == subgraphPool.token0.id
          ? subgraphPool.token1.id
          : subgraphPool.token0.id;
      })
      .flatMap((secondHopId: string) => {
        return _(subgraphPoolsSorted)
          .filter((subgraphPool) => {
            return (
              !poolAddressesSoFar.has(subgraphPool.id) &&
              (subgraphPool.token0.id == secondHopId ||
                subgraphPool.token1.id == secondHopId)
            );
          })
          .slice(0, topNSecondHop)
          .value();
      })
      .uniqBy((pool) => pool.id)
      .sortBy((tokenListPool) => -tokenListPool.totalValueLockedUSDFloat)
      .slice(0, topNSecondHop)
      .value();

    addToAddressSet(topByTVLUsingTokenInSecondHops);

    const topByTVLUsingTokenOutSecondHops = _(topByTVLUsingTokenOut)
      .map((subgraphPool) => {
        return tokenOutAddress == subgraphPool.token0.id
          ? subgraphPool.token1.id
          : subgraphPool.token0.id;
      })
      .flatMap((secondHopId: string) => {
        return _(subgraphPoolsSorted)
          .filter((subgraphPool) => {
            return (
              !poolAddressesSoFar.has(subgraphPool.id) &&
              (subgraphPool.token0.id == secondHopId ||
                subgraphPool.token1.id == secondHopId)
            );
          })
          .slice(0, topNSecondHop)
          .value();
      })
      .uniqBy((pool) => pool.id)
      .sortBy((tokenListPool) => -tokenListPool.totalValueLockedUSDFloat)
      .slice(0, topNSecondHop)
      .value();

    addToAddressSet(topByTVLUsingTokenOutSecondHops);

    log.info(
      {
        topByBaseWithTokenIn: topByBaseWithTokenIn.map(printSubgraphPool),
        topByBaseWithTokenOut: topByBaseWithTokenOut.map(printSubgraphPool),
        topByTVL: topByTVL.map(printSubgraphPool),
        topByTVLUsingTokenIn: topByTVLUsingTokenIn.map(printSubgraphPool),
        topByTVLUsingTokenOut: topByTVLUsingTokenOut.map(printSubgraphPool),
        topByTVLUsingTokenInSecondHops:
          topByTVLUsingTokenInSecondHops.map(printSubgraphPool),
        topByTVLUsingTokenOutSecondHops:
          topByTVLUsingTokenOutSecondHops.map(printSubgraphPool),
        top2DirectSwap: top2DirectSwapPool.map(printSubgraphPool),
        top2EthQuotePool: top2EthQuoteTokenPool.map(printSubgraphPool),
      },
      `Pools for consideration using top ${topN} for TVL, ${topNTokenInOut} in/out, ${topNSecondHop} second hop`
    );

    const subgraphPools = _([
      ...topByBaseWithTokenIn,
      ...topByBaseWithTokenOut,
      ...top2DirectSwapPool,
      ...top2EthQuoteTokenPool,
      ...topByTVL,
      ...topByTVLUsingTokenIn,
      ...topByTVLUsingTokenOut,
      ...topByTVLUsingTokenInSecondHops,
      ...topByTVLUsingTokenOutSecondHops,
    ])
      .compact()
      .uniqBy((pool) => pool.id)
      .value();

    const tokenAddresses = _(subgraphPools)
      .flatMap((subgraphPool) => [
        subgraphPool.token0.id,
        subgraphPool.token1.id,
      ])
      .compact()
      .value();

    log.info(
      `Getting the ${tokenAddresses.length} tokens within the pools for consideration`
    );

    const tokenAccessor = await this.tokenProvider.getTokens(tokenAddresses, {
      blockNumber,
    });

    const tokenPairsRaw = _.map<
      SubgraphPool,
      [Token, Token, FeeAmount] | undefined
    >(subgraphPools, (subgraphPool) => {
      const tokenA = tokenAccessor.getTokenByAddress(subgraphPool.token0.id);
      const tokenB = tokenAccessor.getTokenByAddress(subgraphPool.token1.id);
      const fee = parseFeeAmount(subgraphPool.feeTier);

      if (!tokenA || !tokenB) {
        log.info(
          `Dropping topN pool for ${subgraphPool.token0.symbol}/${
            subgraphPool.token1.symbol
          }/${fee} because ${
            tokenA ? subgraphPool.token1.symbol : subgraphPool.token0.symbol
          } not found by token provider`
        );
        return undefined;
      }

      return [tokenA, tokenB, fee];
    });

    const tokenPairs = _.compact(tokenPairsRaw);

    const beforePoolsLoad = Date.now();

    const poolAccessor = await this.poolProvider.getPools(tokenPairs);

    metric.putMetric(
      'PoolsLoad',
      Date.now() - beforePoolsLoad,
      MetricLoggerUnit.Milliseconds
    );

    const poolsBySelection: PoolsBySelection = {
      topByBaseWithTokenIn,
      topByBaseWithTokenOut,
      top2DirectSwapPool,
      top2EthQuoteTokenPool,
      topByTVL,
      topByTVLUsingTokenIn,
      topByTVLUsingTokenOut,
      topByTVLUsingTokenInSecondHops,
      topByTVLUsingTokenOutSecondHops,
    };

    return { poolAccessor, poolsBySelection };
  }

  private computeAllRoutes(
    tokenIn: Token,
    tokenOut: Token,
    pools: Pool[],
    maxHops: number
  ): RouteSOR[] {
    const poolsUsed = Array<Boolean>(pools.length).fill(false);
    const routes: RouteSOR[] = [];

    const computeRoutes = (
      tokenIn: Token,
      tokenOut: Token,
      currentRoute: Pool[],
      poolsUsed: Boolean[],
      _previousTokenOut?: Token
    ) => {
      if (currentRoute.length > maxHops) {
        return;
      }

      if (
        currentRoute.length > 0 &&
        currentRoute[currentRoute.length - 1]!.involvesToken(tokenOut)
      ) {
        routes.push(new RouteSOR([...currentRoute], tokenIn, tokenOut));
        return;
      }

      for (let i = 0; i < pools.length; i++) {
        if (poolsUsed[i]) {
          continue;
        }

        const curPool = pools[i]!;
        const previousTokenOut = _previousTokenOut
          ? _previousTokenOut
          : tokenIn;

        if (!curPool.involvesToken(previousTokenOut)) {
          continue;
        }

        const currentTokenOut = curPool.token0.equals(previousTokenOut)
          ? curPool.token1
          : curPool.token0;

        currentRoute.push(curPool);
        poolsUsed[i] = true;
        computeRoutes(
          tokenIn,
          tokenOut,
          currentRoute,
          poolsUsed,
          currentTokenOut
        );
        poolsUsed[i] = false;
        currentRoute.pop();
      }
    };

    computeRoutes(tokenIn, tokenOut, [], poolsUsed);

    log.info(
      { routes: routes.map(routeToString) },
      `Computed ${routes.length} possible routes.`
    );

    return routes;
  }

  private buildTrade<TTradeType extends TradeType>(
    tokenInCurrency: Currency,
    tokenOutCurrency: Currency,
    tradeType: TTradeType,
    routeAmounts: RouteAmount[]
  ): Trade<Currency, Currency, TTradeType> {
    const routes = _.map<
      RouteAmount,
      {
        route: Route<Currency, Currency>;
        inputAmount: CurrencyAmount;
        outputAmount: CurrencyAmount;
      }
    >(routeAmounts, (routeAmount: RouteAmount) => {
      const { route, amount, quote } = routeAmount;

      // The route, amount and quote are all in terms of wrapped tokens.
      // When constructing the Trade object the inputAmount/outputAmount must
      // use native currencies if necessary. This is so that the Trade knows to wrap/unwrap.
      if (tradeType == TradeType.EXACT_INPUT) {
        const amountCurrency = CurrencyAmount.fromFractionalAmount(
          tokenInCurrency,
          amount.numerator,
          amount.denominator
        );
        const quoteCurrency = CurrencyAmount.fromFractionalAmount(
          tokenOutCurrency,
          quote.numerator,
          quote.denominator
        );

        const routeCurrency = new Route(
          route.pools,
          amountCurrency.currency,
          quoteCurrency.currency
        );

        return {
          route: routeCurrency,
          inputAmount: amountCurrency,
          outputAmount: quoteCurrency,
        };
      } else {
        const quoteCurrency = CurrencyAmount.fromFractionalAmount(
          tokenInCurrency,
          quote.numerator,
          quote.denominator
        );

        const amountCurrency = CurrencyAmount.fromFractionalAmount(
          tokenOutCurrency,
          amount.numerator,
          amount.denominator
        );

        const routeCurrency = new Route(
          route.pools,
          quoteCurrency.currency,
          amountCurrency.currency
        );

        return {
          route: routeCurrency,
          inputAmount: quoteCurrency,
          outputAmount: amountCurrency,
        };
      }
    });

    const trade = Trade.createUncheckedTradeWithMultipleRoutes({
      routes,
      tradeType,
    });

    return trade;
  }

  private buildMethodParameters(
    trade: Trade<Currency, Currency, TradeType>,
    swapConfig: SwapConfig
  ): MethodParameters {
    const { recipient, slippageTolerance, deadline, inputTokenPermit } =
      swapConfig;

    const methodParameters = SwapRouter.swapCallParameters(trade, {
      recipient,
      slippageTolerance,
      deadline,
      inputTokenPermit,
    });

    return methodParameters;
  }

  private emitPoolSelectionMetrics(
    swapRouteRaw: {
      quote: CurrencyAmount;
      quoteGasAdjusted: CurrencyAmount;
      routeAmounts: RouteAmount[];
      estimatedGasUsed: BigNumber;
    },
    poolsBySelection: PoolsBySelection
  ) {
    const { routeAmounts } = swapRouteRaw;
    const poolAddressesUsed = new Set<string>();

    _(routeAmounts)
      .flatMap((routeAmount) => {
        const {
          route: { pools },
        } = routeAmount;
        return _.map(pools, (pool) =>
          Pool.getAddress(pool.token0, pool.token1, pool.fee).toLowerCase()
        );
      })
      .forEach((address: string) => {
        poolAddressesUsed.add(address);
      });

    _.forIn(
      poolsBySelection,
      (pools: SubgraphPool[], topNSelection: string) => {
        const topNUsed =
          _.findLastIndex(pools, (pool) =>
            poolAddressesUsed.has(pool.id.toLowerCase())
          ) + 1;
        metric.putMetric(
          _.capitalize(topNSelection),
          topNUsed,
          MetricLoggerUnit.Count
        );
      }
    );
  }

  private emitGasModelLog(routeWithQuotes: RouteWithValidQuote[]) {
    if (routeWithQuotes.length > 1) {
      return;
    }

    const routeWithQuote = routeWithQuotes[0]!;
    const {
      initializedTicksCrossedList,
      quoterGasEstimate,
      tradeType,
      rawQuote,
      route,
    } = routeWithQuote;
    const initTicksCrossedTotal = _.sum(initializedTicksCrossedList);

    log.info(
      {
        initTicksCrossedTotal,
        quoterGasEstimate: quoterGasEstimate.toString(),
        tradeType,
        rawQuote: rawQuote.toString(),
        numPools: route.pools.length,
        chainId: route.chainId,
        gasInfo: true,
      },
      'Log for gas model'
    );
  }
}