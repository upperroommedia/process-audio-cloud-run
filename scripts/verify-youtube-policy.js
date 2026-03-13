const assert = require('node:assert/strict');

const {
  classifyYouTubeFailure,
  shouldEscalateToBrowserFallback,
  shouldEscalateToCookieProvider,
  annotateYouTubeFailure,
} = require('../dist/youtubeExtractionPolicy');

function main() {
  assert.equal(
    classifyYouTubeFailure("ERROR: [youtube] Sign in to confirm you're not a bot", 'public_provider'),
    'public_path_bot_blocked'
  );
  assert.equal(
    classifyYouTubeFailure('ERROR: [youtube] The page needs to be reloaded.', 'cookie_provider'),
    'cookie_session_stale_or_challenged'
  );
  assert.equal(
    classifyYouTubeFailure('ERROR: LOGIN_REQUIRED private members-only age-restricted', 'public_provider'),
    'account_required_content'
  );

  assert.equal(shouldEscalateToCookieProvider('account_required_content', true, false), true);
  assert.equal(shouldEscalateToCookieProvider('public_path_bot_blocked', true, false), true);
  assert.equal(shouldEscalateToCookieProvider('unknown_youtube_extractor_failure', true, false), false);
  assert.equal(shouldEscalateToCookieProvider('account_required_content', false, false), false);
  assert.equal(shouldEscalateToCookieProvider('unknown_youtube_extractor_failure', true, true), true);

  assert.equal(shouldEscalateToBrowserFallback('cookie_session_stale_or_challenged', true), true);
  assert.equal(shouldEscalateToBrowserFallback('provider_missing_or_unhealthy', true), false);
  assert.equal(shouldEscalateToBrowserFallback('unknown_youtube_extractor_failure', false), false);

  const annotated = annotateYouTubeFailure(
    'ERROR: [youtube] The page needs to be reloaded.',
    'cookie_session_stale_or_challenged',
    'cookie_provider'
  );
  assert.match(annotated, /Rotate the yt-dlp cookies/i);

  console.log('youtube policy verification passed');
}

main();
