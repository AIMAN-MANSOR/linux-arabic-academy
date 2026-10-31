/* Public browser configuration only. */
const CONFIG = {
  SUPABASE_URL: 'https://supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_BuqBfbo8z9eLN1dD_ybwYA_pQXsdscw',
  telegramChannel: '@something_37',
  telegramChannelUrl: 'https://t.me',
  telegramBotUsername: 'LinuxArabicAcademyBot',
  mode: 'supabase'
};

// تأمين تصدير الكائن ليكون متاحاً لـ app.js بكافة الصيغ المتوقعة
window.CONFIG = CONFIG;
window.PLATFORM_CONFIG = CONFIG;
