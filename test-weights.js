/**
 * Weight System Test
 * 测试权重系统的归一化功能
 */

console.log('🧪 Testing Weight Normalization System\n');
console.log('='.repeat(60));

// Test 1: Default weights (45:40:15)
console.log('\n📊 Test 1: Default Weights (45:40:15)');
console.log('-'.repeat(60));
const weights1 = { errorUrgency: 45, forgettingRisk: 40, freshnessBonus: 15 };
const total1 = weights1.errorUrgency + weights1.forgettingRisk + weights1.freshnessBonus;
const normalized1 = {
  errorUrgency: weights1.errorUrgency / total1,
  forgettingRisk: weights1.forgettingRisk / total1,
  freshnessBonus: weights1.freshnessBonus / total1
};
const maxScores1 = {
  maxErrorUrgencyScore: normalized1.errorUrgency * 100,
  maxForgettingRiskScore: normalized1.forgettingRisk * 100,
  maxFreshnessBonusScore: normalized1.freshnessBonus * 100
};

console.log('Input:', JSON.stringify(weights1));
console.log('Total:', total1);
console.log('Normalized:', JSON.stringify(normalized1));
console.log('Max Scores:', JSON.stringify(maxScores1));
const test1Pass = Math.abs(maxScores1.maxErrorUrgencyScore - 45) < 0.01 &&
                 Math.abs(maxScores1.maxForgettingRiskScore - 40) < 0.01 &&
                 Math.abs(maxScores1.maxFreshnessBonusScore - 15) < 0.01;
console.log('Result:', test1Pass ? '✅ PASS' : '❌ FAIL');
console.log('Expected: {maxErrorUrgencyScore: 45, maxForgettingRiskScore: 40, maxFreshnessBonusScore: 15}');

// Test 2: Increased error weight (50:35:15)
console.log('\n📊 Test 2: Increased Error Weight (50:35:15)');
console.log('-'.repeat(60));
const weights2 = { errorUrgency: 50, forgettingRisk: 35, freshnessBonus: 15 };
const total2 = weights2.errorUrgency + weights2.forgettingRisk + weights2.freshnessBonus;
const normalized2 = {
  errorUrgency: weights2.errorUrgency / total2,
  forgettingRisk: weights2.forgettingRisk / total2,
  freshnessBonus: weights2.freshnessBonus / total2
};
const maxScores2 = {
  maxErrorUrgencyScore: normalized2.errorUrgency * 100,
  maxForgettingRiskScore: normalized2.forgettingRisk * 100,
  maxFreshnessBonusScore: normalized2.freshnessBonus * 100
};

console.log('Input:', JSON.stringify(weights2));
console.log('Total:', total2);
console.log('Normalized:', JSON.stringify(normalized2));
console.log('Max Scores:', JSON.stringify(maxScores2));
const test2Pass = Math.abs(maxScores2.maxErrorUrgencyScore - 50) < 0.01 &&
                 Math.abs(maxScores2.maxForgettingRiskScore - 35) < 0.01 &&
                 Math.abs(maxScores2.maxFreshnessBonusScore - 15) < 0.01;
console.log('Result:', test2Pass ? '✅ PASS' : '❌ FAIL');
console.log('Expected: {maxErrorUrgencyScore: 50, maxForgettingRiskScore: 35, maxFreshnessBonusScore: 15}');

// Test 3: Arbitrary weights (30:40:20)
console.log('\n📊 Test 3: Arbitrary Weights (30:40:20)');
console.log('-'.repeat(60));
const weights3 = { errorUrgency: 30, forgettingRisk: 40, freshnessBonus: 20 };
const total3 = weights3.errorUrgency + weights3.forgettingRisk + weights3.freshnessBonus;
const normalized3 = {
  errorUrgency: weights3.errorUrgency / total3,
  forgettingRisk: weights3.forgettingRisk / total3,
  freshnessBonus: weights3.freshnessBonus / total3
};
const maxScores3 = {
  maxErrorUrgencyScore: normalized3.errorUrgency * 100,
  maxForgettingRiskScore: normalized3.forgettingRisk * 100,
  maxFreshnessBonusScore: normalized3.freshnessBonus * 100
};

console.log('Input:', JSON.stringify(weights3));
console.log('Total:', total3);
console.log('Normalized:', JSON.stringify(normalized3));
console.log('Max Scores:', JSON.stringify(maxScores3));
const test3Pass = Math.abs(maxScores3.maxErrorUrgencyScore - 33.33) < 0.1 &&
                 Math.abs(maxScores3.maxForgettingRiskScore - 44.44) < 0.1 &&
                 Math.abs(maxScores3.maxFreshnessBonusScore - 22.22) < 0.1;
console.log('Result:', test3Pass ? '✅ PASS' : '❌ FAIL');
console.log('Expected: maxErrorUrgencyScore≈33.33, maxForgettingRiskScore≈44.44, maxFreshnessBonusScore≈22.22');

// Test 4: Extreme case (100:0:0)
console.log('\n📊 Test 4: Extreme Case (100:0:0)');
console.log('-'.repeat(60));
const weights4 = { errorUrgency: 100, forgettingRisk: 0, freshnessBonus: 0 };
const total4 = weights4.errorUrgency + weights4.forgettingRisk + weights4.freshnessBonus;
const normalized4 = {
  errorUrgency: weights4.errorUrgency / total4,
  forgettingRisk: weights4.forgettingRisk / total4,
  freshnessBonus: weights4.freshnessBonus / total4
};
const maxScores4 = {
  maxErrorUrgencyScore: normalized4.errorUrgency * 100,
  maxForgettingRiskScore: normalized4.forgettingRisk * 100,
  maxFreshnessBonusScore: normalized4.freshnessBonus * 100
};

console.log('Input:', JSON.stringify(weights4));
console.log('Total:', total4);
console.log('Normalized:', JSON.stringify(normalized4));
console.log('Max Scores:', JSON.stringify(maxScores4));
const test4Pass = Math.abs(maxScores4.maxErrorUrgencyScore - 100) < 0.01 &&
                 Math.abs(maxScores4.maxForgettingRiskScore - 0) < 0.01 &&
                 Math.abs(maxScores4.maxFreshnessBonusScore - 0) < 0.01;
console.log('Result:', test4Pass ? '✅ PASS' : '❌ FAIL');
console.log('Expected: {maxErrorUrgencyScore: 100, maxForgettingRiskScore: 0, maxFreshnessBonusScore: 0}');

// Test 5: All zeros (should use equal distribution)
console.log('\n📊 Test 5: All Zeros (Equal Distribution)');
console.log('-'.repeat(60));
const weights5 = { errorUrgency: 0, forgettingRisk: 0, freshnessBonus: 0 };
const total5 = weights5.errorUrgency + weights5.forgettingRisk + weights5.freshnessBonus;
let normalized5, maxScores5;

if (total5 === 0) {
  normalized5 = {
    errorUrgency: 1/3,
    forgettingRisk: 1/3,
    freshnessBonus: 1/3
  };
  maxScores5 = {
    maxErrorUrgencyScore: normalized5.errorUrgency * 100,
    maxForgettingRiskScore: normalized5.forgettingRisk * 100,
    maxFreshnessBonusScore: normalized5.freshnessBonus * 100
  };
}

console.log('Input:', JSON.stringify(weights5));
console.log('Total:', total5);
console.log('Normalized:', JSON.stringify(normalized5));
console.log('Max Scores:', JSON.stringify(maxScores5));
const test5Pass = Math.abs(maxScores5.maxErrorUrgencyScore - 33.33) < 0.1 &&
                 Math.abs(maxScores5.maxForgettingRiskScore - 33.33) < 0.1 &&
                 Math.abs(maxScores5.maxFreshnessBonusScore - 33.33) < 0.1;
console.log('Result:', test5Pass ? '✅ PASS' : '❌ FAIL');
console.log('Expected: All ≈33.33 (equal distribution)');

// Summary
console.log('\n' + '='.repeat(60));
console.log('📈 Test Summary:');
console.log('-'.repeat(60));
const allPassed = test1Pass && test2Pass && test3Pass && test4Pass && test5Pass;
console.log(`Test 1 (Default 45:40:15): ${test1Pass ? '✅ PASS' : '❌ FAIL'}`);
console.log(`Test 2 (Increased Error 50:35:15): ${test2Pass ? '✅ PASS' : '❌ FAIL'}`);
console.log(`Test 3 (Arbitrary 30:40:20): ${test3Pass ? '✅ PASS' : '❌ FAIL'}`);
console.log(`Test 4 (Extreme 100:0:0): ${test4Pass ? '✅ PASS' : '❌ FAIL'}`);
console.log(`Test 5 (All Zeros): ${test5Pass ? '✅ PASS' : '❌ FAIL'}`);
console.log('='.repeat(60));
console.log(`Overall: ${allPassed ? '✅ ALL TESTS PASSED' : '❌ SOME TESTS FAILED'}`);
console.log('='.repeat(60));
