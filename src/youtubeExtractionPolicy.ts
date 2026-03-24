export type YouTubeExtractionMode = 'public_provider' | 'cookie_provider' | 'browser_fallback';

export type YouTubeFailureClass =
  | 'provider_missing_or_unhealthy'
  | 'public_path_bot_blocked'
  | 'cookie_session_stale_or_challenged'
  | 'account_required_content'
  | 'browser_fallback_failed'
  | 'unknown_youtube_extractor_failure';

export type YouTubeAlertCode =
  | 'public_ip_or_reputation_block'
  | 'cookie_session_stale'
  | 'account_required_no_valid_session'
  | 'browser_fallback_failed'
  | 'provider_unhealthy'
  | 'youtube_runtime_failure';

export function classifyYouTubeFailure(message: string, mode: YouTubeExtractionMode): YouTubeFailureClass {
  const lower = message.toLowerCase();

  if (
    lower.includes('po token providers: none') ||
    lower.includes('ytdlp_pot_provider_base_url is required') ||
    lower.includes('po token provider') && lower.includes('unhealthy')
  ) {
    return 'provider_missing_or_unhealthy';
  }

  if (lower.includes('the page needs to be reloaded') || lower.includes('unplayable')) {
    return mode === 'cookie_provider' ? 'cookie_session_stale_or_challenged' : 'public_path_bot_blocked';
  }

  if (lower.includes("sign in to confirm you're not a bot") || lower.includes('sign in to confirm you’re not a bot')) {
    return mode === 'cookie_provider' ? 'cookie_session_stale_or_challenged' : 'public_path_bot_blocked';
  }

  if (
    lower.includes('login_required') ||
    lower.includes('this video is private') ||
    lower.includes('members-only') ||
    lower.includes('this video is available to this channel') ||
    lower.includes('age-restricted') ||
    lower.includes('this content isn\'t available') ||
    lower.includes('sign in to confirm your age')
  ) {
    return 'account_required_content';
  }

  if (mode === 'browser_fallback') {
    return 'browser_fallback_failed';
  }

  return 'unknown_youtube_extractor_failure';
}

export function shouldEscalateToCookieProvider(
  failureClass: YouTubeFailureClass,
  hasCookieFallback: boolean,
  useCookiesForPublicVideos: boolean
): boolean {
  if (!hasCookieFallback) return false;
  if (useCookiesForPublicVideos) return true;

  return failureClass === 'account_required_content' || failureClass === 'public_path_bot_blocked';
}

export function shouldEscalateToBrowserFallback(
  failureClass: YouTubeFailureClass,
  browserFallbackEnabled: boolean
): boolean {
  if (!browserFallbackEnabled) return false;

  return (
    failureClass === 'public_path_bot_blocked' ||
    failureClass === 'cookie_session_stale_or_challenged' ||
    failureClass === 'account_required_content' ||
    failureClass === 'unknown_youtube_extractor_failure'
  );
}

export function annotateYouTubeFailure(
  message: string,
  failureClass: YouTubeFailureClass,
  mode: YouTubeExtractionMode
): string {
  switch (failureClass) {
    case 'provider_missing_or_unhealthy':
      return `${message} Verify the PO-token provider service and YTDLP_POT_PROVIDER_BASE_URL before retrying.`;
    case 'public_path_bot_blocked':
      return `${message} The public YouTube extraction path was challenged. Verify provider health and the worker's outbound IP reputation.`;
    case 'cookie_session_stale_or_challenged':
      return `${message} The configured YouTube cookie session appears stale or challenged. Rotate the yt-dlp cookies from a fresh private browsing session and retry.`;
    case 'account_required_content':
      return `${message} This video appears to require an authenticated YouTube session. Verify dedicated service-account cookies are configured and healthy.`;
    case 'browser_fallback_failed':
      return `${message} Browser fallback also failed. Inspect the browser fallback worker and its persistent authenticated profile.`;
    case 'unknown_youtube_extractor_failure':
    default:
      return mode === 'browser_fallback'
        ? `${message} Browser fallback failed with an unknown extraction error.`
        : `${message} yt-dlp failed with an unknown YouTube extraction error.`;
  }
}

export function toYouTubeAlertCode(failureClass: YouTubeFailureClass): YouTubeAlertCode {
  switch (failureClass) {
    case 'provider_missing_or_unhealthy':
      return 'provider_unhealthy';
    case 'public_path_bot_blocked':
      return 'public_ip_or_reputation_block';
    case 'cookie_session_stale_or_challenged':
      return 'cookie_session_stale';
    case 'account_required_content':
      return 'account_required_no_valid_session';
    case 'browser_fallback_failed':
      return 'browser_fallback_failed';
    case 'unknown_youtube_extractor_failure':
    default:
      return 'youtube_runtime_failure';
  }
}
