/**
 * 🔍 同步调试工具 - 用于诊断同步失败原因
 */

import { supabase } from '../lib/supabaseClient';

/**
 * 测试数据库连接和权限
 */
export const testDatabaseConnection = async () => {
  console.log('🔍 [Debug] Testing database connection...');

  const tests = {
    auth: false,
    sessionsRead: false,
    sessionsWrite: false,
    wordsRead: false,
    wordsWrite: false
  };

  // 1. 测试认证状态
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError) {
    console.error('❌ [Debug] Auth failed:', authError);
  } else {
    console.log('✅ [Debug] Auth OK, user:', user?.id);
    tests.auth = true;
  }

  if (!user?.id) {
    console.error('❌ [Debug] No user found, aborting test');
    return tests;
  }

  const userId = user.id;

  // 2. 测试读取 sessions
  const { data: sessions, error: sessionsReadError } = await supabase
    .from('sessions')
    .select('id, name, user_id')
    .eq('user_id', userId)
    .limit(1);

  if (sessionsReadError) {
    console.error('❌ [Debug] Sessions read failed:', sessionsReadError);
  } else {
    console.log('✅ [Debug] Sessions read OK, count:', sessions?.length);
    tests.sessionsRead = true;
  }

  // 3. 测试写入 sessions（创建测试 session）
  const testSessionId = `debug_test_${Date.now()}`;
  const { data: newSession, error: sessionWriteError } = await supabase
    .from('sessions')
    .insert({
      id: testSessionId,
      user_id: userId,
      word_count: 0,
      target_count: 5,
      library_tag: 'Debug',
      created_at: new Date().toISOString()
    })
    .select('id')
    .single();

  if (sessionWriteError) {
    console.error('❌ [Debug] Session write failed:', sessionWriteError);
    console.error('   Error details:', {
      message: sessionWriteError.message,
      details: sessionWriteError.details,
      hint: sessionWriteError.hint,
      code: sessionWriteError.code
    });
  } else {
    console.log('✅ [Debug] Session write OK, id:', newSession?.id);
    tests.sessionsWrite = true;

    // 清理测试数据
    await supabase
      .from('sessions')
      .delete()
      .eq('id', testSessionId);
  }

  // 4. 测试读取 words
  const { data: words, error: wordsReadError } = await supabase
    .from('words')
    .select('id, text, user_id')
    .eq('user_id', userId)
    .limit(1);

  if (wordsReadError) {
    console.error('❌ [Debug] Words read failed:', wordsReadError);
  } else {
    console.log('✅ [Debug] Words read OK, count:', words?.length);
    tests.wordsRead = true;
  }

  // 5. 测试写入 words
  const testWordId = `debug_word_${Date.now()}`;
  const { data: newWord, error: wordWriteError } = await supabase
    .from('words')
    .insert({
      id: testWordId,
      user_id: userId,
      session_id: testSessionId,
      text: 'debug_test',
      correct: false,
      tested: false
    })
    .select('id')
    .single();

  if (wordWriteError) {
    console.error('❌ [Debug] Word write failed:', wordWriteError);
    console.error('   Error details:', {
      message: wordWriteError.message,
      details: wordWriteError.details,
      hint: wordWriteError.hint,
      code: wordWriteError.code
    });
  } else {
    console.log('✅ [Debug] Word write OK, id:', newWord?.id);
    tests.wordsWrite = true;

    // 清理测试数据
    await supabase
      .from('words')
      .delete()
      .eq('id', testWordId);
  }

  // 6. 检查 RLS policies
  console.log('🔍 [Debug] Checking RLS policies...');

  const { data: policies, error: policiesError } = await supabase
    .rpc('get_policies', { params: { tablename: 'sessions' } });

  if (policiesError) {
    console.warn('⚠️ [Debug] Could not check RLS policies');
  } else {
    console.log('✅ [Debug] RLS policies retrieved');
  }

  // 总结
  console.log('\n📊 [Debug] Test Summary:');
  console.log('   Auth:', tests.auth ? '✅' : '❌');
  console.log('   Sessions Read:', tests.sessionsRead ? '✅' : '❌');
  console.log('   Sessions Write:', tests.sessionsWrite ? '✅' : '❌');
  console.log('   Words Read:', tests.wordsRead ? '✅' : '❌');
  console.log('   Words Write:', tests.wordsWrite ? '✅' : '❌');

  const allPassed = Object.values(tests).every(t => t === true);
  console.log('\n' + (allPassed ? '✅ All tests passed!' : '❌ Some tests failed!'));

  return tests;
};

/**
 * 诊断具体同步失败原因
 */
export const diagnoseSyncFailure = async (sessionId: string, userId: string) => {
  console.log(`🔍 [Debug] Diagnosing sync failure for session: ${sessionId}`);

  const issues: string[] = [];

  // 1. 检查 session 是否存在于云端
  const { data: cloudSession, error: fetchError } = await supabase
    .from('sessions')
    .select('*')
    .eq('id', sessionId)
    .eq('user_id', userId)
    .maybeSingle();

  if (fetchError) {
    issues.push(`Fetch session failed: ${fetchError.message}`);
    issues.push(`Error code: ${fetchError.code}`);
    issues.push(`Error hint: ${fetchError.hint}`);
  }

  if (!cloudSession) {
    issues.push('Session does not exist in cloud (should upload new)');
  } else {
    console.log('✅ [Debug] Session found in cloud:', cloudSession.id);
  }

  // 2. 检查 words 是否存在
  const { data: cloudWords, error: wordsError } = await supabase
    .from('words')
    .select('id')
    .eq('session_id', sessionId)
    .eq('user_id', userId)
    .limit(1);

  if (wordsError) {
    issues.push(`Fetch words failed: ${wordsError.message}`);
  } else {
    console.log(`✅ [Debug] Found ${cloudWords?.length || 0} words in cloud`);
  }

  // 3. 检查是否有唯一性约束问题
  if (cloudSession && cloudWords && cloudWords.length > 0) {
    console.log('🔍 [Debug] Checking for potential constraint violations...');

    // 检查是否有重复的 word IDs
    const uniqueIds = new Set(cloudWords.map(w => w.id));
    if (uniqueIds.size !== cloudWords.length) {
      issues.push(`Duplicate word IDs detected in cloud data`);
    }
  }

  return {
    hasIssues: issues.length > 0,
    issues,
    cloudSession,
    cloudWordsCount: cloudWords?.length || 0
  };
};
