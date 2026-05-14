export const translations = {
  en: {
    // App states
    neuralLinkSevered: 'NEURAL LINK SEVERED',
    dbMissingDesc: 'Database credentials are missing. The application cannot synchronize with the cloud matrix.',
    configureEnvVars: 'Please configure your environment variables.',
    syncingNeuralLink: 'SYNCING NEURAL LINK...',
    retryConnection: 'RETRY CONNECTION',

    // Delete modal
    confirmDeletion: 'CONFIRM DELETION',
    deleting: 'DELETING...',
    preparing: 'Preparing...',
    deletingWords: 'Deleting words...',
    deletingSessions: 'Deleting sessions...',
    cleaningTags: 'Cleaning up tags...',
    cancel: 'CANCEL',
    deleteForever: 'DELETE FOREVER',
    deleteWarning: 'WARNING: This action will permanently remove all associated words from your library and the cloud database. This process is irreversible.',
    deleteConfirmText: (count: number) => `You are about to delete ${count} session(s).`,

    // Sync conflict modal
    syncConflict: 'SYNC CONFLICT',
    syncConflictDesc: 'A conflict was detected between cloud and local versions. Please select the version to keep:',
    cloudVersion: '云端版本',
    localVersion: '本地版本',

    // Header & Footer
    cloudSynced: 'CLOUD SYNCED',
    footerText: '© 2024 VOCAB MONSTER - CLOUD SYNCED',

    // Landing page
    vocabMonsterTag: 'VOCAB MONSTER V1.1',
    buildUp: 'BUILD UP',
    levelUp: 'LEVEL UP',
    landingDesc: 'Enhance your typing skills. Master your vocabulary. Earn badges and turn your daily learning into an addictive adventure.',
    startNow: 'START NOW',
    createAccountPrompt: 'Create account or Login to sync progress',
    challengeMode: 'CHALLENGE MODE',
    typeTheWord: 'TYPE THE WORD',

    // Calendar
    today: 'Today',
    monthNames: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
    dayLabels: ['M', 'T', 'W', 'T', 'F', 'S', 'S'],

    // Stats
    daysUnit: 'Days',
    collected: 'COLLECTED',

    // TestMode
    syncingNeuralDatabase: 'Syncing Neural Database',
    syncingPleaseWait: 'Please wait while we secure your progress...',
    forceExit: 'Force Exit',

    // Smart selection descriptions
    smartSelectionOff: 'OFF: Random selection from checked words',
    smartSelectionOn: 'ON: Intelligent selection based on error history & forgetting curve',

    // Account panel
    terminateSession: 'Terminate Session',

    // Language toggle
    language: 'EN',
    languageLabel: 'Language',

    // Auth page
    authProcessing: 'PROCESSING...',
    authStart: 'START',
    authInitiate: 'INITIATE ACCOUNT',
    authOrDivider: 'or',
    continueWithGoogle: 'CONTINUE WITH GOOGLE',
    continueWithWatcha: 'CONTINUE WITH 观猹',
    needAccount: 'Need an account? Sign Up',
    haveAccount: 'Already have an account? Login',
    msgAlreadyRegistered: 'This email is already registered. Please switch to "Login" mode to sign in. If you\'ve forgotten your password, use "Forgot Password" option below.',
    msgEmailNotConfirmedSignup: "Your account exists but email hasn't been confirmed yet. Please check your inbox (including spam folder) or click \"Resend Email\" below.",
    msgAccountCreatedConfirm: '🎉 Account created! Please check your email to activate your account (including spam folder).',
    msgAccountCreatedLogin: '✅ Account created and logged in successfully!',
    msgLoginSuccess: 'Welcome back! 🎮 Loading your data...',
    msgInvalidCredentials: (n: number) => `Invalid email or password (${n}/3 attempts). Please try again.`,
    msgInvalidCredentials3: '❌ Invalid password (3 attempts). Forgot your password? Click "Forgot Password" below to reset it.',
    msgEmailNotConfirmedLogin: 'Please confirm your email address first. Check your inbox (including spam folder).',
    msgResendEmailSuccess: '📧 Activation email resent! Please check your inbox (including spam folder).',

    // Dashboard
    addWords: 'ADD WORDS',
    testSelected: (n: number) => `TEST SELECTED (${n})`,
    quickTest: 'QUICK TEST',
    dashboardDesc: 'Master vocabulary with challenges and AI.',
    wordsUnit: (n: number) => `${n} WORDS`,
    imagePreview: 'Image Preview',
    returnToDashboard: 'RETURN TO DASHBOARD',

    // TestMode results
    correctOutOf: (correct: number, total: number) => `${correct} correct out of ${total}`,
    reviewReasonBoth: 'Reveal + Hint',
    reviewReasonReveal: 'Reveal',
    reviewReasonHint: 'Hint Trials',
    clickToFlip: 'click to flip',
    testComplete: 'Test Complete!',
    correctWords: 'Correct Words',
    totalPoints: 'Total Points',
    timeElapsed: 'Time',
    reviewWordsCleared: 'Review Words Cleared',
    restoreSystem: 'RESTORE SYSTEM',
  },
  zh: {
    // App states
    neuralLinkSevered: '神经连接中断',
    dbMissingDesc: '数据库凭证缺失，应用无法与云端矩阵同步。',
    configureEnvVars: '请配置环境变量。',
    syncingNeuralLink: '正在同步神经链路...',
    retryConnection: '重试连接',

    // Delete modal
    confirmDeletion: '确认删除',
    deleting: '删除中...',
    preparing: '准备中...',
    deletingWords: '正在删除单词...',
    deletingSessions: '正在删除学习批次...',
    cleaningTags: '正在清理标签...',
    cancel: '取消',
    deleteForever: '永久删除',
    deleteWarning: '警告：此操作将永久删除词库中所有相关单词以及云端数据库中的记录，操作不可撤销。',
    deleteConfirmText: (count: number) => `你即将删除 ${count} 个学习批次。`,

    // Sync conflict modal
    syncConflict: '同步冲突',
    syncConflictDesc: '检测到云端和本地有不同版本，请选择要保留的版本：',
    cloudVersion: '云端版本',
    localVersion: '本地版本',

    // Header & Footer
    cloudSynced: '云端已同步',
    footerText: '© 2024 词汇怪兽 - 云端同步',

    // Landing page
    vocabMonsterTag: '词汇怪兽 V1.1',
    buildUp: '积累词汇',
    levelUp: '提升自我',
    landingDesc: '提升打字技能，掌握词汇量。获得徽章，将每日学习变成让人上瘾的冒险。',
    startNow: '立即开始',
    createAccountPrompt: '注册账号或登录以同步进度',
    challengeMode: '挑战模式',
    typeTheWord: '输入单词',

    // Calendar
    today: '今天',
    monthNames: ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'],
    dayLabels: ['一', '二', '三', '四', '五', '六', '日'],

    // Stats
    daysUnit: '天',
    collected: '已获得',

    // TestMode
    syncingNeuralDatabase: '正在同步神经数据库',
    syncingPleaseWait: '请稍等，正在保存您的进度...',
    forceExit: '强制退出',

    // Smart selection descriptions
    smartSelectionOff: '关闭：从勾选的单词中随机选择',
    smartSelectionOn: '开启：根据错误历史和遗忘曲线智能选择',

    // Account panel
    terminateSession: '退出登录',

    // Language toggle
    language: '中文',
    languageLabel: '语言',

    // Auth page
    authProcessing: '处理中...',
    authStart: '开始',
    authInitiate: '创建账号',
    authOrDivider: '或',
    continueWithGoogle: '使用 Google 登录',
    continueWithWatcha: '使用 观猹 登录',
    needAccount: '没有账号？立即注册',
    haveAccount: '已有账号？直接登录',
    msgAlreadyRegistered: '该邮箱已注册，请切换至"登录"模式。如忘记密码，请使用下方的"忘记密码"功能。',
    msgEmailNotConfirmedSignup: '账号已存在但邮箱未验证。请检查收件箱（含垃圾邮件）或点击下方"重新发送邮件"。',
    msgAccountCreatedConfirm: '🎉 账号创建成功！请查收验证邮件以激活账号（含垃圾邮件箱）。',
    msgAccountCreatedLogin: '✅ 账号创建并登录成功！',
    msgLoginSuccess: '欢迎回来！🎮 正在加载你的数据...',
    msgInvalidCredentials: (n: number) => `邮箱或密码错误（${n}/3 次尝试），请重试。`,
    msgInvalidCredentials3: '❌ 密码错误已达3次。忘记密码？请点击下方"忘记密码"重置。',
    msgEmailNotConfirmedLogin: '请先确认邮箱地址，查看收件箱（含垃圾邮件箱）。',
    msgResendEmailSuccess: '📧 激活邮件已重新发送！请查收邮件（含垃圾邮件箱）。',

    // Dashboard
    addWords: '添加单词',
    testSelected: (n: number) => `测试已选（${n}）`,
    quickTest: '快速测试',
    dashboardDesc: '用挑战和 AI 掌握词汇。',
    wordsUnit: (n: number) => `${n} 个单词`,
    imagePreview: '图片预览',
    returnToDashboard: '返回仪表盘',

    // TestMode results
    correctOutOf: (correct: number, total: number) => `共 ${total} 题，答对 ${correct} 题`,
    reviewReasonBoth: '揭示 + 提示',
    reviewReasonReveal: '揭示答案',
    reviewReasonHint: '提示练习',
    clickToFlip: '点击翻面',
    testComplete: '测试完成！',
    correctWords: '答对单词',
    totalPoints: '总得分',
    timeElapsed: '用时',
    reviewWordsCleared: '已完成复习词',
    restoreSystem: '返回主界面',
  },
} as const;

export type Translations = typeof translations.en;
