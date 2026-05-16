
const express = require('express');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 8000;

const POLL_INTERVAL = 800;
const RETRY_DELAY = 5000;
const MAX_HISTORY = 1000;
const ID_TAG = "@anhphong06";

let latest_result_100 = {
  Phien: 0,
  Xuc_xac_1: 0,
  Xuc_xac_2: 0,
  Xuc_xac_3: 0,
  Tong_diem: 0,
  Pattern: "Chua co",
  Phien_hien_tai: 0,
  Du_doan: "Chua co",
  Tong_du_doan: 0,
  Tong_thang: 0,
  Tong_thua: 0,
  Id: ID_TAG
};

let latest_result_101 = {
  Phien: 0,
  Xuc_xac_1: 0,
  Xuc_xac_2: 0,
  Xuc_xac_3: 0,
  Tong_diem: 0,
  Pattern: "Chua co",
  Phien_hien_tai: 0,
  Du_doan: "Chua co",
  Tong_du_doan: 0,
  Tong_thang: 0,
  Tong_thua: 0,
  Id: ID_TAG
};

let history_100 = [];
let history_101 = [];
let last_sid_100 = null;
let last_sid_101 = null;
let sid_for_tx = null;

let globalStats = {
  ban_tai_xiu: {
    totalPredictions: 0,
    totalWins: 0,
    totalLosses: 0
  },
  ban_md5: {
    totalPredictions: 0,
    totalWins: 0,
    totalLosses: 0
  }
};

// Helper function: Detect streak and break probability
function detectStreakAndBreak(history) {
  if (!history || history.length === 0) return { streak: 0, currentResult: null, breakProb: 0.0 };
  let streak = 1;
  const currentResult = history[history.length - 1].result;
  for (let i = history.length - 2; i >= 0; i--) {
    if (history[i].result === currentResult) {
      streak++;
    } else {
      break;
    }
  }
  const last20 = history.slice(-20).map(h => h.result); // Tăng lên 20 phiên
  if (!last20.length) return { streak, currentResult, breakProb: 0.0 };
  const switches = last20.slice(1).reduce((count, curr, idx) => count + (curr !== last20[idx] ? 1 : 0), 0);
  const taiCount = last20.filter(r => r === 'Tài').length;
  const xiuCount = last20.filter(r => r === 'Xỉu').length;
  const imbalance = Math.abs(taiCount - xiuCount) / last20.length;
  let breakProb = 0.0;

  // Điều chỉnh xác suất bẻ cầu
  if (streak >= 8) {
    breakProb = Math.min(0.6 + (switches / 20) + imbalance * 0.15, 0.9); // Giảm ngưỡng
  } else if (streak >= 5) {
    breakProb = Math.min(0.35 + (switches / 15) + imbalance * 0.25, 0.85); // Giảm ngưỡng
  } else if (streak >= 3 && switches >= 8) { // Tăng số lần chuyển đổi yêu cầu
    breakProb = 0.3;
  }

  return { streak, currentResult, breakProb };
}

// Helper function: Evaluate model performance
function evaluateModelPerformance(history, modelName, lookback = 15) { // Tăng lookback
  if (!modelPredictions[modelName] || history.length < 2) return 1.0;
  lookback = Math.min(lookback, history.length - 1);
  let correctCount = 0;
  for (let i = 0; i < lookback; i++) {
    const pred = modelPredictions[modelName][history[history.length - (i + 2)].session] || 0;
    const actual = history[history.length - (i + 1)].result;
    if ((pred === 1 && actual === 'Tài') || (pred === 2 && actual === 'Xỉu')) {
      correctCount++;
    }
  }
  const performanceScore = lookback > 0 ? 1.0 + (correctCount - lookback / 2) / (lookback / 2) : 1.0;
  return Math.max(0.5, Math.min(1.5, performanceScore)); // Giới hạn score để tránh lệch
}

// Helper function: Smart bridge break model
function smartBridgeBreak(history) {
  if (!history || history.length < 5) return { prediction: 0, breakProb: 0.0, reason: 'Không đủ dữ liệu để bẻ cầu' };

  const { streak, currentResult, breakProb } = detectStreakAndBreak(history);
  const last30 = history.slice(-30).map(h => h.result); // Tăng lịch sử lên 30
  const lastScores = history.slice(-20).map(h => h.totalScore || 0);
  let breakProbability = breakProb;
  let reason = '';

  // Analyze score trends
  const avgScore = lastScores.reduce((sum, score) => sum + score, 0) / (lastScores.length || 1);
  const scoreDeviation = lastScores.reduce((sum, score) => sum + Math.abs(score - avgScore), 0) / (lastScores.length || 1);

  // Detect specific bridge patterns
  const last5 = last30.slice(-5);
  const patternCounts = {};
  for (let i = 0; i <= last30.length - 3; i++) {
    const pattern = last30.slice(i, i + 3).join(',');
    patternCounts[pattern] = (patternCounts[pattern] || 0) + 1;
  }
  const mostCommonPattern = Object.entries(patternCounts).sort((a, b) => b[1] - a[1])[0];
  const isStablePattern = mostCommonPattern && mostCommonPattern[1] >= 4; // Tăng ngưỡng lặp mẫu

  // Adjust break probability
  if (streak >= 7) { // Tăng ngưỡng streak
    breakProbability = Math.min(breakProbability + 0.15, 0.9);
    reason = `[Bẻ Cầu] Chuỗi ${streak} ${currentResult} dài, khả năng bẻ cầu cao`;
  } else if (streak >= 4 && scoreDeviation > 3.5) { // Tăng ngưỡng deviation
    breakProbability = Math.min(breakProbability + 0.1, 0.85);
    reason = `[Bẻ Cầu] Biến động điểm số lớn (${scoreDeviation.toFixed(1)}), khả năng bẻ cầu tăng`;
  } else if (isStablePattern && last5.every(r => r === currentResult)) {
    breakProbability = Math.min(breakProbability + 0.05, 0.8);
    reason = `[Bẻ Cầu] Phát hiện mẫu lặp ${mostCommonPattern[0]}, có khả năng bẻ cầu`;
  } else {
    breakProbability = Math.max(breakProbability - 0.15, 0.15); // Giảm xác suất bẻ cầu
    reason = `[Bẻ Cầu] Không phát hiện mẫu bẻ cầu mạnh, tiếp tục theo cầu`;
  }

  let prediction;

if (breakProbability > 0.72) {
  prediction = currentResult === 'Tài' ? 2 : 1;
} else {
  prediction = currentResult === 'Tài' ? 1 : 2;
}
  return { prediction, breakProb: breakProbability, reason };
}

// Helper function: Check bad pattern
function isBadPattern(history) {
  if (!history || history.length < 5) return false;
  const last20 = history.slice(-20).map(h => h.result);
  if (!last20.length) return false;
  const switches = last20.slice(1).reduce((count, curr, idx) => count + (curr !== last20[idx] ? 1 : 0), 0);
  const { streak } = detectStreakAndBreak(history);
  return switches >= 14;
}

// AI HTDD Logic
function aiHtddLogic(history) {
  if (!history || history.length < 5) {
  return {
    prediction: 'Bỏ',
    reason: '[AI] Không đủ dữ liệu',
    source: 'AI HTDD'
  };
}

const recentHistory = history.slice(-7).map(h => h.result);
  const recentScores = history.slice(-7).map(h => h.totalScore || 0);
  const taiCount = recentHistory.filter(r => r === 'Tài').length;
  const xiuCount = recentHistory.filter(r => r === 'Xỉu').length;

  // Phân tích mẫu dài hơn
  if (history.length >= 5) {
    const last5 = history.slice(-5).map(h => h.result);
    if (last5.join(',') === 'Tài,Xỉu,Tài,Xỉu,Tài') {
      return { prediction: 'Xỉu', reason: '[AI] Phát hiện mẫu 1T1X lặp → tiếp theo nên đánh Xỉu', source: 'AI HTDD' };
    } else if (last5.join(',') === 'Xỉu,Tài,Xỉu,Tài,Xỉu') {
      return { prediction: 'Tài', reason: '[AI] Phát hiện mẫu 1X1T lặp → tiếp theo nên đánh Tài', source: 'AI HTDD' };
    }
  }

  // Kiểm tra chuỗi dài
  if (history.length >= 10 && history.slice(-7).every(h => h.result === 'Tài')) {
    return { prediction: 'Xỉu', reason: '[AI] Chuỗi Tài quá dài (7 lần) → dự đoán Xỉu', source: 'AI HTDD' };
  } else if (history.length >= 10 && history.slice(-7).every(h => h.result === 'Xỉu')) {
    return { prediction: 'Tài', reason: '[AI] Chuỗi Xỉu quá dài (7 lần) → dự đoán Tài', source: 'AI HTDD' };
  }

  // Phân tích điểm số
  const avgScore = recentScores.reduce((sum, score) => sum + score, 0) / (recentScores.length || 1);
  if (avgScore > 10.5) { // Tăng ngưỡng
    return { prediction: 'Tài', reason: `[AI] Điểm trung bình cao (${avgScore.toFixed(1)}) → dự đoán Tài`, source: 'AI HTDD' };
  } else if (avgScore < 7.5) { // Giảm ngưỡng
    return { prediction: 'Xỉu', reason: `[AI] Điểm trung bình thấp (${avgScore.toFixed(1)}) → dự đoán Xỉu`, source: 'AI HTDD' };
  }

  // Cân bằng dài hạn
  const overallTai = history.filter(h => h.result === 'Tài').length;
  const overallXiu = history.filter(h => h.result === 'Xỉu').length;
  if (Math.abs(overallTai - overallXiu) / history.length > 0.3) {
    return {
      prediction: overallTai > overallXiu ? 'Xỉu' : 'Tài',
      reason: `[AI] Tổng thể ${overallTai > overallXiu ? 'Tài' : 'Xỉu'} chiếm đa số → dự đoán ngược lại để cân bằng`,
      source: 'AI HTDD'
    };
  }

  return {
    prediction: taiCount > xiuCount ? 'Tài' : 'Xỉu',
reason: `[AI] Theo xu hướng gần nhất`,
    source: 'AI HTDD'
  };
}
function trendAndProb(history) {
  const last = history.slice(-5);
  const tai = last.filter(x => x.result === 'Tài').length;
  return tai >= 3 ? 1 : 2;
}

function shortPattern(history) {
  const last = history.slice(-3);
  const tai = last.filter(x => x.result === 'Tài').length;
  return tai >= 2 ? 1 : 2;
}

function meanDeviation(history) {
  const avg = history.reduce((a,b)=>a+b.totalScore,0)/history.length;
  return avg > 10 ? 1 : 2;
}

function recentSwitch(history) {
  if(history.length < 2) return 1;
  const last = history[history.length - 1].result;
  const prev = history[history.length - 2].result;
  return last === 'Tài' ? 1 : 2;
}

let modelPredictions = {
  trend: {},
  short: {},
  mean: {},
  switch: {},
  bridge: {}
};
// Main prediction function
function generatePrediction(history, modelPredictionsRef) {
  modelPredictions = modelPredictionsRef;
  if (!history || history.length === 0) {
    console.log('No history available, generating random prediction');
    const randomResult = Math.random() < 0.5 ? 'Tài' : 'Xỉu';
    console.log('Random Prediction:', randomResult);
    return randomResult;
  }

  if (!modelPredictions['trend']) {
    modelPredictions['trend'] = {};
    modelPredictions['short'] = {};
    modelPredictions['mean'] = {};
    modelPredictions['switch'] = {};
    modelPredictions['bridge'] = {};
  }

  const currentIndex = history[history.length - 1].session;

  // Run models
  const trendPred = trendAndProb(history);
  const shortPred = shortPattern(history);
  const meanPred = meanDeviation(history);
  const switchPred = recentSwitch(history);
  const bridgePred = smartBridgeBreak(history);
  const aiPred = aiHtddLogic(history);

  // Store predictions
  modelPredictions['trend'][currentIndex] = trendPred;
  modelPredictions['short'][currentIndex] = shortPred;
  modelPredictions['mean'][currentIndex] = meanPred;
  modelPredictions['switch'][currentIndex] = switchPred;
  modelPredictions['bridge'][currentIndex] = bridgePred.prediction;

  // Evaluate model performance
  const modelScores = {
    trend: evaluateModelPerformance(history, 'trend'),
    short: evaluateModelPerformance(history, 'short'),
    mean: evaluateModelPerformance(history, 'mean'),
    switch: evaluateModelPerformance(history, 'switch'),
    bridge: evaluateModelPerformance(history, 'bridge')
  };

  // Điều chỉnh trọng số
  const weights = {
  trend: 0.35 * modelScores.trend,
  short: 0.25 * modelScores.short,
  mean: 0.15 * modelScores.mean,
  switch: 0.05 * modelScores.switch,
  bridge: 0.15 * modelScores.bridge,
  aihtdd: 0.25
};

  let taiScore = 0;
  let xiuScore = 0;

  if (trendPred === 1) taiScore += weights.trend; else if (trendPred === 2) xiuScore += weights.trend;
  if (shortPred === 1) taiScore += weights.short; else if (shortPred === 2) xiuScore += weights.short;
  if (meanPred === 1) taiScore += weights.mean; else if (meanPred === 2) xiuScore += weights.mean;
  if (switchPred === 1) taiScore += weights.switch; else if (switchPred === 2) xiuScore += weights.switch;
  if (bridgePred.prediction === 1) taiScore += weights.bridge; else if (bridgePred.prediction === 2) xiuScore += weights.bridge;
  if (aiPred.prediction === 'Tài') taiScore += weights.aihtdd; else xiuScore += weights.aihtdd;

  

  // Cân bằng nếu dự đoán nghiêng quá nhiều
  const last10Preds = history.slice(-10).map(h => h.result);
  const taiPredCount = last10Preds.filter(r => r === 'Tài').length;
  if (taiPredCount >= 7) {
    xiuScore += 0.2; // Tăng xác suất Xỉu
    console.log('Adjusting for too many Tài predictions');
  } else if (taiPredCount <= 3) {
    taiScore += 0.2; // Tăng xác suất Tài
    console.log('Adjusting for too many Xỉu predictions');
  }

  // Điều chỉnh dựa trên xác suất bẻ cầu
  if (bridgePred.breakProb > 0.65) {
    console.log('High bridge break probability:', bridgePred.breakProb, bridgePred.reason);
    if (bridgePred.prediction === 1) taiScore += 0.25; else xiuScore += 0.25; // Giảm ảnh hưởng
  }

  if (Math.abs(taiScore - xiuScore) < 0.10) {
  console.log('LOW CONFIDENCE');
}

const finalPrediction =
taiScore > xiuScore ? 'Tài' : 'Xỉu';
  console.log('Prediction:', { prediction: finalPrediction, reason: `${aiPred.reason} | ${bridgePred.reason}`, scores: { taiScore, xiuScore } });
  return finalPrediction;
}

class AdvancedMarkovAnalyzer {
  constructor({
    states = ['Tai', 'Xiu'],
    order = 2,
    decay = 0.98,
    laplace = 1,
    memories = [3, 10, 50],
    maxHistory = 1000
  } = {}) {
    this.states = states;
    this.order = Math.max(1, order);
    this.decay = decay;
    this.laplace = laplace;
    this.memories = memories;
    this.maxHistory = maxHistory;
    this.transitionCounts = new Map();
    this.patternFreq = new Map();
    this.rawHistory = [];
    this.predictionHistory = new Map();
  }

  contextKey(prevStates) {
    return prevStates.join('|');
  }

  applyDecayToAll() {
    const decayFactor = this.decay;
    for (const [ctx, counts] of this.transitionCounts.entries()) {
      const newCounts = {};
      let total = 0;
      for (const s of this.states) {
        const v = (counts[s] || 0) * decayFactor;
        newCounts[s] = v;
        total += v;
      }
      if (total < 1e-6) {
        this.transitionCounts.delete(ctx);
      } else {
        this.transitionCounts.set(ctx, newCounts);
      }
    }

    for (const [pat, cnt] of this.patternFreq.entries()) {
      const v = cnt * decayFactor;
      if (v < 1e-6) this.patternFreq.delete(pat);
      else this.patternFreq.set(pat, v);
    }
  }

  update(actualState) {
    if (!this.states.includes(actualState)) {
      throw new Error("Unknown state: " + actualState);
    }

    this.rawHistory.push(actualState);
    if (this.rawHistory.length > this.maxHistory) {
      this.rawHistory.shift();
    }

    const L = this.rawHistory.length;
    const maxPat = Math.min(this.order, L);
    for (let patLen = 1; patLen <= maxPat; patLen++) {
      const seq = this.rawHistory.slice(L - patLen, L).join('|');
      const prev = this.patternFreq.get(seq) || 0;
      this.patternFreq.set(seq, prev + 1);
    }

    for (let k = 1; k <= this.order; k++) {
      if (this.rawHistory.length - 1 - (k - 1) < 0) break;
      const ctxStart = this.rawHistory.length - 1 - (k);
      if (ctxStart < 0) continue;
      const ctx = this.rawHistory.slice(ctxStart, ctxStart + k).join('|');
      const counts = this.transitionCounts.get(ctx) || {};
      counts[actualState] = (counts[actualState] || 0) + 1;
      this.transitionCounts.set(ctx, counts);
    }

    if (this.rawHistory.length % 20 === 0) {
      this.applyDecayToAll();
    }
  }

  getProbabilitiesForContext(ctx) {
    const counts = this.transitionCounts.get(ctx) || {};
    let sum = 0;
    for (const s of this.states) sum += (counts[s] || 0);
    const K = this.states.length;
    const probs = {};
    for (const s of this.states) {
      const c = (counts[s] || 0);
      probs[s] = (c + this.laplace) / (sum + this.laplace * K);
    }
    return probs;
  }

  predictEnsemble() {
    const aggregate = {};
    for (const s of this.states) aggregate[s] = 0;

    const L = this.rawHistory.length;
    if (L === 0) {
      const uniform = 1 / this.states.length;
      for (const s of this.states) aggregate[s] = uniform;
      return { probs: aggregate, chosen: this.states[0], confidence: 0 };
    }

    for (const mem of this.memories) {
      const memSize = Math.min(mem, L);
      const orderForMem = Math.min(this.order, memSize);
      const ctx = this.rawHistory.slice(L - orderForMem, L).join('|');
      const probs = this.getProbabilitiesForContext(ctx);
      const weight = 1 / (1 + Math.log(1 + mem));

      for (const s of this.states) {
        aggregate[s] += probs[s] * weight;
      }
    }

    let total = 0;
    for (const s of this.states) total += aggregate[s];
    if (total <= 0) {
      const uniform = 1 / this.states.length;
      for (const s of this.states) aggregate[s] = uniform;
    } else {
      for (const s of this.states) aggregate[s] /= total;
    }

    let chosen = this.states[0];
    let best = aggregate[chosen];
    for (const s of this.states) {
      if (aggregate[s] > best) {
        best = aggregate[s];
        chosen = s;
      }
    }

    const confidence = Math.abs(aggregate[this.states[0]] - aggregate[this.states[1]]);

    return { probs: aggregate, chosen, confidence };
  }

  getPatternFrequency(pattern) {
    return this.patternFreq.get(pattern) || 0;
  }

  topPatterns(k = 20, maxLen = undefined) {
    const arr = [];
    for (const [pat, cnt] of this.patternFreq.entries()) {
      const parts = pat.split('|');
      if (maxLen && parts.length > maxLen) continue;
      arr.push({ pattern: pat, count: cnt, length: parts.length });
    }
    arr.sort((a,b) => b.count - a.count);
    return arr.slice(0,k);
  }

  savePrediction(phien, result) {
    this.predictionHistory.set(phien, { ...result, timestamp: Date.now() });
    if (this.predictionHistory.size > 500) {
      const oldest = Array.from(this.predictionHistory.keys())[0];
      this.predictionHistory.delete(oldest);
    }
  }

  getPrediction(phien) {
    return this.predictionHistory.get(phien);
  }

  getFullAnalysis() {
    const memAnalyses = {};
    for (const mem of this.memories) {
      const memSize = Math.min(mem, this.rawHistory.length);
      const orderForMem = Math.min(this.order, memSize);
      const ctx = this.rawHistory.slice(this.rawHistory.length - orderForMem, this.rawHistory.length).join('|');
      memAnalyses[`m${mem}`] = {
        context: ctx,
        probs: this.getProbabilitiesForContext(ctx)
      };
    }

    return {
      order: this.order,
      decay: this.decay,
      laplace: this.laplace,
      memories: this.memories,
      rawHistoryLength: this.rawHistory.length,
      rawHistorySample: this.rawHistory.slice(-Math.min(50, this.rawHistory.length)),
      transitionContextsStored: this.transitionCounts.size,
      topPatterns: this.topPatterns(30, this.order),
      memoryAnalyses: memAnalyses
    };
  }
}

const advanced_tx = new AdvancedMarkovAnalyzer({
  order: 2,
  decay: 0.96,
  laplace: 1,
  memories: [3, 10, 50],
  maxHistory: 2000
});

const advanced_md5 = new AdvancedMarkovAnalyzer({
  order: 2,
  decay: 0.96,
  laplace: 1,
  memories: [3, 10, 50],
  maxHistory: 2000
});

function formatBeautifulJSON(data) {
  return JSON.stringify(data, null, 2);
}

function updateResult(store, history, analyzer, stats, result, tableName) {
  Object.assign(store, result);

  const actualResult = store.Tong_diem > 10 ? 'Tài' : 'Xỉu';
  store.Pattern = actualResult;

  analyzer.update(actualResult);

  const vipPrediction = generatePrediction(
  history.map(h => ({
    session: h.Phien,
    result: h.Ket_qua === 'Tai' ? 'Tài' : 'Xỉu',
    totalScore: h.Tong_diem
  })),
  modelPredictions
);

const pred = analyzer.predictEnsemble();

// Phiên hiện tại đang chạy
store.Phien_hien_tai = Number(store.Phien) + 1;

// LUÔN CÓ DỰ ĐOÁN
if (vipPrediction !== 'Bỏ') {
  store.Du_doan =
  vipPrediction === 'Tài' || vipPrediction === 'Xỉu'
    ? vipPrediction
    : (pred.chosen === 'Tai' ? 'Tài' : 'Xỉu');
// Boost confidence thật hơn
let finalConfidence = pred.confidence;

// AI + bridge cùng hướng => tăng
if (
  (vipPrediction === 'Tài' && pred.chosen === 'Tai') ||
  (vipPrediction === 'Xỉu' && pred.chosen === 'Xiu')
) {
  finalConfidence += 0.08;
}

// Giới hạn
if (finalConfidence > 0.99) finalConfidence = 0.99;

store.Du_doan_confidence = parseFloat(
  finalConfidence.toFixed(3)
);

store.Du_doan_probs = pred.probs;

  analyzer.savePrediction(store.Phien_hien_tai, {
    prediction: pred.chosen,
    probs: pred.probs,
    confidence: pred.confidence
  });

  if (history.length >= 1) {
    const previousGame = history[0];
    const prevPredRecord = analyzer.getPrediction(previousGame.Phien);
    if (prevPredRecord && prevPredRecord.prediction) {
      stats.totalPredictions++;
      const wasCorrect = prevPredRecord.prediction === actualResult;
      if (wasCorrect) stats.totalWins++;
      else stats.totalLosses++;

      previousGame.Tong_thang = stats.totalWins;
      previousGame.Tong_thua = stats.totalLosses;
      previousGame.Tong_du_doan = stats.totalPredictions;
      previousGame.Du_doan = prevPredRecord.prediction;
      previousGame.Danh_gia = wasCorrect ? 'Dung' : 'Sai';

      console.log(`[${tableName}] EVAL Phien ${previousGame.Phien} | Du doan: ${prevPredRecord.prediction} | Thuc te: ${actualResult} | ${wasCorrect ? '✅' : '❌'}`);
    }
  }

  const historyEntry = {
    ...result,
    Ket_qua: actualResult,
    Tong_thang: stats.totalWins,
    Tong_thua: stats.totalLosses,
    Tong_du_doan: stats.totalPredictions,
    Id: ID_TAG
  };

  history.unshift(historyEntry);
  if (history.length > MAX_HISTORY) history.pop();

  store.Tong_du_doan = stats.totalPredictions;
  store.Tong_thang = stats.totalWins;
  store.Tong_thua = stats.totalLosses;
  store.Id = ID_TAG;

  console.log(`[${tableName}] 🎲 Phien ${store.Phien} | Tong: ${store.Tong_diem} | KQ: ${actualResult} | Du doan tiep theo: ${store.Du_doan} (conf ${store.Du_doan_confidence})`);
}

async function pollTaiXiu() {
  const url = `https://jakpotgwab.geightdors.net/glms/v1/notify/taixiu?platform_id=rik&gid=vgmn_100`;

  while (true) {
    try {
      const res = await axios.get(url, {
        headers: { 'User-Agent': 'Node-Proxy/1.0' },
        timeout: 10000
      });

      const data = res.data;
      if (data && data.status === 'OK' && Array.isArray(data.data)) {
        for (const game of data.data) {
          if (game.cmd === 1008) {
            sid_for_tx = game.sid;
          }
        }

        for (const game of data.data) {
          if (game.cmd === 1003) {
            const sid = sid_for_tx;
            const { d1, d2, d3 } = game;
            if (sid && sid !== last_sid_100 && [d1,d2,d3].every(x => x != null)) {
              last_sid_100 = sid;
              const total = d1 + d2 + d3;
              const result = {
                const result = {
  Phien: sid,
  Xuc_xac_1: d1,
  Xuc_xac_2: d2,
  Xuc_xac_3: d3,
  Tong_diem: total,
  Pattern: "",
  Phien_hien_tai: Number(sid) + 1,
  Du_doan: "Chua co",
  Tong_du_doan: 0,
  Tong_thang: 0,
  Tong_thua: 0,
  Id: ID_TAG
};

              updateResult(latest_result_100, history_100, advanced_tx, globalStats.ban_tai_xiu, result, "BAN TAI XIU");

              const analysis = advanced_tx.getFullAnalysis();
              console.log('─'.repeat(60));
              console.log(`🎯 [Ban Tai Xiu] Analysis: order=${analysis.order}, historyLen=${analysis.rawHistoryLength}`);
              console.log(`🔮 Next prediction: ${latest_result_100.Du_doan} | Conf: ${latest_result_100.Du_doan_confidence}`);
              console.log(`📊 Wins: ${globalStats.ban_tai_xiu.totalWins}/${globalStats.ban_tai_xiu.totalPredictions}`);
              console.log('─'.repeat(60));

              sid_for_tx = null;
            }
          }
        }
      }
    } catch (err) {
      console.error("Loi khi lay du lieu TX:", err.message || err);
      await new Promise(r => setTimeout(r, RETRY_DELAY));
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
}

async function pollMD5() {
  const url = `https://jakpotgwab.geightdors.net/glms/v1/notify/taixiu?platform_id=rik&gid=vgmn_101`;

  while (true) {
    try {
      const res = await axios.get(url, {
        headers: { 'User-Agent': 'Node-Proxy/1.0' },
        timeout: 10000
      });

      const data = res.data;
      
      if (data && data.status === 'OK' && data.data && Array.isArray(data.data)) {
        for (const game of data.data) {
          if (
  game.cmd === 7006 &&
  game.d1 != null &&
  game.d2 != null &&
  game.d3 != null
) {

const sid = game.sid;

if (sid && sid !== last_sid_101) {
              last_sid_101 = sid;
              const total = game.d1 + game.d2 + game.d3;
              
              const result = {
  Phien: sid,
  Xuc_xac_1: game.d1,
  Xuc_xac_2: game.d2,
  Xuc_xac_3: game.d3,
  Tong_diem: total,
  Pattern: "",
  Phien_hien_tai: Number(sid) + 1,
  Du_doan: "Chua co",
  Tong_du_doan: 0,
  Tong_thang: 0,
  Tong_thua: 0,
  Id: ID_TAG
};

              updateResult(latest_result_101, history_101, advanced_md5, globalStats.ban_md5, result, "BAN MD5");

              const analysis = advanced_md5.getFullAnalysis();
              console.log('─'.repeat(60));
              console.log(`🎯 [Ban MD5] Analysis: order=${analysis.order}, historyLen=${analysis.rawHistoryLength}`);
              console.log(`🔮 Next prediction: ${latest_result_101.Du_doan} | Conf: ${latest_result_101.Du_doan_confidence}`);
              console.log(`📊 Wins: ${globalStats.ban_md5.totalWins}/${globalStats.ban_md5.totalPredictions}`);
              console.log('─'.repeat(60));
            }
          }
        }
      }
    } catch (err) {
      console.error("Loi khi lay du lieu MD5:", err.message || err);
      await new Promise(r => setTimeout(r, RETRY_DELAY));
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
}

// APIs
app.get('/api/taixiu', (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(formatBeautifulJSON(latest_result_100));
});

app.get('/api/md5', (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(formatBeautifulJSON(latest_result_101));
});

app.get('/api/history', (req, res) => {
  const lich_su = history_100.map(item => {
    return {
      Phien: item.Phien,
      Du_doan: item.Du_doan || 'Chua co',
      Ket_qua: item.Ket_qua,
      Danh_gia: item.Danh_gia || 'Chua danh gia'
    };
  });

  const historyData = {
    ban: "Tai Xiu",
    Tong_so_phien_du_doan: globalStats.ban_tai_xiu.totalPredictions,
    Tong_du_doan_dung: globalStats.ban_tai_xiu.totalWins,
    Tong_du_doan_sai: globalStats.ban_tai_xiu.totalLosses,
    lich_su: lich_su
  };

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(formatBeautifulJSON(historyData));
});

app.get('/api/history/md5', (req, res) => {
  const lich_su = history_101.map(item => {
    return {
      Phien: item.Phien,
      Du_doan: item.Du_doan || 'Chua co',
      Ket_qua: item.Ket_qua,
      Danh_gia: item.Danh_gia || 'Chua danh gia'
    };
  });

  const historyData = {
    ban: "MD5",
    Tong_so_phien_du_doan: globalStats.ban_md5.totalPredictions,
    Tong_du_doan_dung: globalStats.ban_md5.totalWins,
    Tong_du_doan_sai: globalStats.ban_md5.totalLosses,
    lich_su: lich_su
  };

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(formatBeautifulJSON(historyData));
});

app.get('/api/stats', (req, res) => {
  const statsData = {
    ban_tai_xiu: {
      accuracy: globalStats.ban_tai_xiu.totalPredictions > 0 ? (globalStats.ban_tai_xiu.totalWins / globalStats.ban_tai_xiu.totalPredictions * 100).toFixed(2) : 0,
      total_predictions: globalStats.ban_tai_xiu.totalPredictions,
      correct_predictions: globalStats.ban_tai_xiu.totalWins,
      incorrect_predictions: globalStats.ban_tai_xiu.totalLosses,
      current_prediction: latest_result_100.Du_doan,
      history_length: advanced_tx.rawHistory.length
    },
    ban_md5: {
      accuracy: globalStats.ban_md5.totalPredictions > 0 ? (globalStats.ban_md5.totalWins / globalStats.ban_md5.totalPredictions * 100).toFixed(2) : 0,
      total_predictions: globalStats.ban_md5.totalPredictions,
      correct_predictions: globalStats.ban_md5.totalWins,
      incorrect_predictions: globalStats.ban_md5.totalLosses,
      current_prediction: latest_result_101.Du_doan,
      history_length: advanced_md5.rawHistory.length
    }
  };

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(formatBeautifulJSON(statsData));
});

app.get('/api/markov', (req, res) => {
  const fullAnalysis = advanced_tx.getFullAnalysis();
  const markovData = {
    ban: "Tai Xiu",
    advanced_config: {
      order: advanced_tx.order,
      decay: advanced_tx.decay,
      laplace: advanced_tx.laplace,
      memories: advanced_tx.memories
    },
    analysis: fullAnalysis
  };

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(formatBeautifulJSON(markovData));
});

app.get('/api/markov/md5', (req, res) => {
  const fullAnalysis = advanced_md5.getFullAnalysis();
  const markovData = {
    ban: "MD5",
    advanced_config: {
      order: advanced_md5.order,
      decay: advanced_md5.decay,
      laplace: advanced_md5.laplace,
      memories: advanced_md5.memories
    },
    analysis: fullAnalysis
  };

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(formatBeautifulJSON(markovData));
});

app.get('/', (req, res) => {
  res.send("🎲 Advanced Analyzer running. Endpoints: /api/taixiu, /api/md5, /api/history, /api/history/md5, /api/stats, /api/markov, /api/markov/md5");
});

console.log("🚀 Khoi dong Advanced Analyzer...");
pollTaiXiu();
pollMD5();

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📌 ID: ${ID_TAG}`);
});
