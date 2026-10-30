/* Public browser configuration only.
 * The publishable/anon key is designed for browser use with Supabase RLS.
 * NEVER put a service_role key or Telegram bot token in this file.
 */
window.PLATFORM_CONFIG = Object.freeze({
  supabaseUrl: 'https://taeksuuaodwpkmnwbrch.supabase.co',
  supabaseAnonKey: 'sb_publishable_BuqBfbo8z9eLNldD_ybWYA_pQXsdscw',
  telegramChannel: '@something_37',
  telegramChannelUrl: 'https://t.me/something_37',
  telegramBotUsername: 'LinuxArabicAcademyBot',
  mode: 'supabase'
});
