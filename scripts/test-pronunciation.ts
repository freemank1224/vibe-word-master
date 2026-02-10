/**
 * Pronunciation Service Test Script
 * Run this in the browser console to test the pronunciation service
 */

// Add this to your test page or run in browser console:
async function testPronunciation() {
  console.log('🔊 Testing Pronunciation Service');
  console.log('=================================');

  const testWords = [
    'hello',
    'pronunciation',
    'algorithm',
    'schedule',
    'beautiful',
    'through',
    'colonel'
  ];

  for (const word of testWords) {
    console.log(`\n📝 Testing: "${word}"`);
    console.log('Playing...');

    try {
      // The service will automatically be imported in the app
      // For manual testing, use the import in your code
      const result = await playWordPronunciation(word, 'en');

      if (result.success) {
        console.log(`✅ Success! Source used: ${result.sourceUsed}`);
      } else {
        console.log(`❌ Failed - All sources unavailable`);
      }
    } catch (error) {
      console.error(`❌ Error:`, error);
    }

    // Wait between words
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  console.log('\n✨ Test complete!');
}

// Test with a single word
async function testSingleWord(word: string) {
  console.log(`🔊 Testing pronunciation for "${word}"`);
  const result = await playWordPronunciation(word, 'en');
  console.log('Result:', result);
  return result;
}

// Export for use
if (typeof window !== 'undefined') {
  (window as any).testPronunciation = testPronunciation;
  (window as any).testSingleWord = testSingleWord;
  console.log('📌 Pronunciation test functions loaded!');
  console.log('   - Run testPronunciation() to test all words');
  console.log('   - Run testSingleWord("yourword") to test a specific word');
}

export { testPronunciation, testSingleWord };
