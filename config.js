/* إعدادات عامة للمتصفح فقط. ضع عنوان مشروع Supabase الحقيقي هنا. */
(() => {
  const config = {
    supabaseUrl: 'https://taeksuuaodwpkmnwbrch.supabase.co',
    supabaseAnonKey: 'sb_publishable_BuqBfbo8z9eLN1dD_ybwYA_pQXsdscw',
    telegramChannel: '@something_37',
    telegramChannelUrl: 'https://t.me/something_37',
    telegramBotUsername: 'LinuxArabicAcademyBot',
    mode: 'supabase'
  };
  config.SUPABASE_URL = config.supabaseUrl;
  config.SUPABASE_ANON_KEY = config.supabaseAnonKey;
  window.CONFIG = config;
  window.PLATFORM_CONFIG = config;
})();
