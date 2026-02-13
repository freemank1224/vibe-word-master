/**
 * Shanghai Timezone Utility (UTC+8)
 *
 * CRITICAL: All time-related operations MUST use Shanghai Time (Asia/Shanghai)
 * to ensure consistency with database which uses 'Asia/Shanghai' timezone.
 *
 * This utility uses toLocaleString() method which properly handles:
 * - Daylight Saving Time (though China doesn't observe DST)
 * - Timezone offsets
 * - Cross-midnight scenarios
 */

/**
 * Get current date in Shanghai Timezone (UTC+8)
 * Returns date string in YYYY-MM-DD format
 *
 * This matches the database calculation:
 * (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE
 *
 * @returns {string} YYYY-MM-DD format date
 */
export function getShanghaiDateString(): string {
  const now = new Date();

  // Use toLocaleString for accurate timezone conversion
  // This is more reliable than manual offset calculation
  const shanghaiString = now.toLocaleString('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  const shanghaiDate = new Date(shanghaiString);

  // Format as YYYY-MM-DD
  const year = shanghaiDate.getFullYear();
  const month = String(shanghaiDate.getMonth() + 1).padStart(2, '0');
  const day = String(shanghaiDate.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

/**
 * Get current timestamp in Shanghai Timezone (UTC+8)
 * Returns milliseconds since epoch in Shanghai timezone
 *
 * @returns {number} Milliseconds timestamp
 */
export function getShanghaiTimestamp(): number {
  const now = new Date();
  const shanghaiString = now.toLocaleString('en-US', {
    timeZone: 'Asia/Shanghai',
    hour12: false
  });
  return new Date(shanghaiString).getTime();
}

/**
 * Check if a given date is "today" in Shanghai Timezone
 *
 * @param {string} dateString - Date string in YYYY-MM-DD format
 * @returns {boolean} True if the date is today
 */
export function isTodayInShanghai(dateString: string): boolean {
  const today = getShanghaiDateString();
  return dateString === today;
}

/**
 * Check if a given date is in the past (before today in Shanghai Timezone)
 *
 * @param {string} dateString - Date string in YYYY-MM-DD format
 * @returns {boolean} True if the date is in the past
 */
export function isPastInShanghai(dateString: string): boolean {
  const today = getShanghaiDateString();
  return dateString < today;
}

/**
 * Format date for display (in Shanghai Timezone context)
 *
 * @param {string} dateStr - Date string in YYYY-MM-DD format
 * @param {'short' | 'long'} format - 'short' (e.g., 'Feb 12') or 'long' (e.g., 'February 12, 2026')
 * @returns {string} Formatted date string
 */
export function formatShanghaiDate(dateStr: string, format: 'short' | 'long' = 'short'): string {
  const [year, month, day] = dateStr.split('-').map(Number);

  if (format === 'short') {
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                         'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${monthNames[month - 1]} ${day}`;
  }

  const monthNamesFull = ['January', 'February', 'March', 'April', 'May', 'June',
                          'July', 'August', 'September', 'October', 'November', 'December'];
  return `${monthNamesFull[month - 1]} ${day}, ${year}`;
}

/**
 * Parse YYYY-MM-DD string and return Date object in Shanghai Timezone
 *
 * @param {string} dateStr - Date string in YYYY-MM-DD format
 * @returns {Date} Date object adjusted to Shanghai timezone
 */
export function parseShanghaiDate(dateStr: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number);
  // Create date at noon in Shanghai timezone to avoid timezone offset issues
  return new Date(Date.UTC(year, month - 1, day, 4, 0, 0) + (8 * 60 * 60 * 1000));
}
