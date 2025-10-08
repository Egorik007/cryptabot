const ccxt = require('ccxt');
const { SMA, RSI, ADX } = require('technicalindicators');

const exchange = new ccxt.bybit({
    apiKey: 'hb0fDEkGCJfHk8WzcQ',  // Вставь Bybit ключи
    secret: 'dZmk1iXSNxyrz72GiGHy0Emr25z721CkuvpW',
    sandbox: false,  // Реал!
    options: { defaultType: 'swap' }  // Perpetual
});

exchange.timeout = 30000;  // Таймаут 30 сек
exchange.options['swap'] = {'category': 'linear'};  // Фикс для USDT perpetual

const symbol = 'SOLUSDT';
const exchange = new ccxt.binance({
    apiKey: 'pBnzadkI7YsvXKFkGtpKlM0iqKCZKIfnxiscqr3WAY3w4IBRDZguWksAMrZOzfO8',  // Вставь свои (Spot права!)
    secret: 'GTIQkF5RkcZJHMkxt0hoYE03jeHFuB65BnUmSuVtfdpZla2NVbokUMbur3pc0DKJ',
    sandbox: false,  // Реал, но малый amount!
    options: { defaultType: 'future' }  // Спот!
});

const symbol = 'ETHUSDT';
const timeframe = '1m';
const shortPeriod = 5;
const longPeriod = 50;
const rsiPeriod = 14;
const rsiBuy = 30;
const rsiSell = 70;
const adxPeriod = 14;
const adxThreshold = 20;
const volumeMult = 1.2;
const amount = 0.05;
const stopLossPct = 0.01;
const takeProfitPct = 0.03;
const amount = 0.006;  // 0.006 ETH (~28$ экв., маржа ~1.12$ с 25x)
const stopLossPct = 0.02;
const takeProfitPct = 0.05;
const leverage = 25;

let position = null;
let entryPrice = 0;

async function initLeverage() {
    try {
        await exchange.setLeverage(leverage, symbol);
        console.log(`Левередж: ${leverage}x установлен!`);
    } catch (error) {
        if (error.message.includes('110043') || error.message.includes('leverage not modified')) {
            console.log(`Левередж: ${leverage}x уже установлен!`);
        } else {
            console.error('Ошибка левереджа:', error.message);
        }
        console.error('Ошибка левереджа:', error.message);
    }
}

async function getData() {
    let attempts = 0;
    while (attempts < 3) {
        try {
            const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, undefined, 100);
            return ohlcv.map(candle => ({
                timestamp: new Date(candle[0]),
                open: candle[1],
                high: candle[2],
                low: candle[3],
                close: candle[4],
                volume: candle[5]
            }));
        } catch (error) {
            attempts++;
            console.error(`Fetch failed, попытка ${attempts}/3: ${error.message}`);
            if (attempts < 3) await new Promise(r => setTimeout(r, 2000));
        }
    }
    console.error('Все попытки fetch failed, пропускаем цикл');
    return [];
}

function calculateIndicators(data) {
    if (data.length < 50) return { currentPrice: 0, rsi: 50, adx: 0, volOk: false };
    const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, undefined, 100);
    return ohlcv.map(candle => ({
        timestamp: new Date(candle[0]),
        open: candle[1],
        high: candle[2],
        low: candle[3],
        close: candle[4],
        volume: candle[5]
    }));
}

function calculateIndicators(data) {
    const closes = data.map(d => d.close);
    const highs = data.map(d => d.high);
    const lows = data.map(d => d.low);
    const volumes = data.map(d => d.volume);

    const smaShort = SMA.calculate({ period: shortPeriod, values: closes });
    const smaLong = SMA.calculate({ period: longPeriod, values: closes });
    const rsi = RSI.calculate({ period: rsiPeriod, values: closes });
    const adxResults = ADX.calculate({ period: adxPeriod, high: highs, low: lows, close: closes });

    const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const volFilter = volumes[volumes.length - 1] > (avgVolume * volumeMult);

    return {
        smaShort: smaShort[smaShort.length - 1],
        smaLong: smaLong[smaLong.length - 1],
        prevSmaShort: smaShort[smaShort.length - 2],
        prevSmaLong: smaLong[smaLong.length - 2],
        rsi: isNaN(rsi[rsi.length - 1]) ? 50 : rsi[rsi.length - 1],
        adx: isNaN(adxResults[adxResults.length - 1]?.adx) ? 0 : adxResults[adxResults.length - 1].adx,
        volOk: volFilter,
        currentPrice: closes[closes.length - 1]
    };
}

function smaCrossoverWithFilters(indicators) {
    const { smaShort, smaLong, prevSmaShort, prevSmaLong, rsi, adx, volOk } = indicators;

    if (smaShort > smaLong && prevSmaShort <= prevSmaLong &&
        rsi < rsiSell && adx > adxThreshold && volOk) {
        return 'BUY';
    }
    if (smaShort < smaLong && prevSmaShort >= prevSmaLong &&
        rsi > rsiBuy && adx > adxThreshold && volOk) {
        return 'SELL';
    }
    return 'HOLD';
}

async function mainLoop() {
    try {
        const data = await getData();
        const indicators = calculateIndicators(data);
        const signal = smaCrossoverWithFilters(indicators);
        const currentPrice = indicators.currentPrice;

        console.log(`Сигнал: ${signal}, Цена: ${currentPrice}, RSI: ${indicators.rsi.toFixed(2)}, ADX: ${indicators.adx.toFixed(2)}`);

        if (signal === 'BUY' && position !== 'long') {
            if (position === 'short') {
                await exchange.createMarketBuyOrder(symbol, amount);
                console.log('Закрываем short!');
            }
            await exchange.createMarketBuyOrder(symbol, amount);
            entryPrice = currentPrice;
            position = 'long';
            console.log(`LONG ${amount} ETH по ${entryPrice}! Экв. ~${(amount * entryPrice * leverage).toFixed(0)}$ | Стоп: ${entryPrice * (1 - stopLossPct)}, Тейк: ${entryPrice * (1 + takeProfitPct)}`);
        } else if (signal === 'SELL' && position !== 'short') {
            if (position === 'long') {
                await exchange.createMarketSellOrder(symbol, amount);
                console.log('Закрываем long!');
            }
            await exchange.createMarketSellOrder(symbol, amount);
            entryPrice = currentPrice;
            position = 'short';
            console.log(`SHORT ${amount} ETH по ${entryPrice}! Экв. ~${(amount * entryPrice * leverage).toFixed(0)}$ | Стоп: ${entryPrice * (1 + stopLossPct)}, Тейк: ${entryPrice * (1 - takeProfitPct)}`);
        } else if (position === 'long') {
            if (currentPrice <= entryPrice * (1 - stopLossPct)) {
                await exchange.createMarketSellOrder(symbol, amount);
                const loss = (currentPrice - entryPrice) / entryPrice * leverage * 100;
                console.log(`Стоп LONG! Убыток: ${loss.toFixed(2)}%`);
                position = null;
            } else if (currentPrice >= entryPrice * (1 + takeProfitPct)) {
                await exchange.createMarketSellOrder(symbol, amount);
                const profit = (currentPrice - entryPrice) / entryPrice * leverage * 100;
                console.log(`Тейк LONG! Профит: ${profit.toFixed(2)}%`);
                position = null;
            }
        } else if (position === 'short') {
            if (currentPrice >= entryPrice * (1 + stopLossPct)) {
                await exchange.createMarketBuyOrder(symbol, amount);
                const loss = (currentPrice - entryPrice) / entryPrice * leverage * 100;
                console.log(`Стоп SHORT! Убыток: ${loss.toFixed(2)}%`);
                position = null;
            } else if (currentPrice <= entryPrice * (1 - takeProfitPct)) {
                await exchange.createMarketBuyOrder(symbol, amount);
                const profit = (entryPrice - currentPrice) / entryPrice * leverage * 100;
                console.log(`Тейк SHORT! Профит: ${profit.toFixed(2)}%`);
                position = null;
            }
        }
    } catch (error) {
        console.error('Ошибка:', error.message);
    }
}

process.on('unhandledRejection', (error) => {
    console.error('Краш:', error.message);
    setTimeout(() => mainLoop(), 10000);
});

// Инит + цикл 1 минута
// Инит + цикл
initLeverage();
mainLoop();
setInterval(mainLoop, 60000);