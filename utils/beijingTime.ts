/**
 * Beijing Time Utility
 *
 * CRITICAL: All time-related operations MUST use Beijing Time (UTC+8)
 * to ensure consistency with the database which uses 'Asia/Shanghai' timezone.
 */

/**
 * Get current date in Beijing Time (UTC+8)
 * Returns date string in YYYY-MM-DD format
 */
export function getBeijingDate(): string {
    const now = new Date();
    // Convert to Beijing Time (UTC+8)
    const beijingTime = new Date(now.getTime() + (8 * 60 * 60 * 1000));
    const year = beijingTime.getUTCFullYear();
    const month = String(beijingTime.getUTCMonth() + 1).padStart(2, '0');
    const day = String(beijingTime.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * Get current datetime in Beijing Time (UTC+8)
 * Returns Date object adjusted to Beijing timezone
 */
export function getBeijingTime(): Date {
    const now = new Date();
    return new Date(now.getTime() + (8 * 60 * 60 * 1000));
}

/**
 * Get Beijing timestamp (milliseconds)
 */
export function getBeijingTimestamp(): number {
    return Date.now() + (8 * 60 * 60 * 1000);
}

/**
 * Check if a given date is today (in Beijing Time)
 * @param dateStr - Date string in YYYY-MM-DD format
 */
export function isTodayInBeijing(dateStr: string): boolean {
    const today = getBeijingDate();
    return dateStr === today;
}

/**
 * Check if a given date is in the past (before today in Beijing Time)
 * @param dateStr - Date string in YYYY-MM-DD format
 */
export function isPastInBeijing(dateStr: string): boolean {
    const today = getBeijingDate();
    return dateStr < today;
}

/**
 * Format date for display (in Beijing Time context)
 * @param dateStr - Date string in YYYY-MM-DD format
 * @param format - 'short' (e.g., 'Feb 12') or 'long' (e.g., 'February 12, 2026')
 */
export function formatBeijingDate(dateStr: string, format: 'short' | 'long' = 'short'): string {
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
 * Parse YYYY-MM-DD string and return Date object adjusted to Beijing Time
 */
export function parseBeijingDate(dateStr: string): Date {
    const [year, month, day] = dateStr.split('-').map(Number);
    // Create date in UTC then add offset to get Beijing Time
    return new Date(Date.UTC(year, month - 1, day) + (8 * 60 * 60 * 1000));
}
