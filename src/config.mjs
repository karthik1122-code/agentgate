// Every environment variable the server reads, in one place.
export const config = {
  port: Number(process.env.PORT || 4200),
  databaseUrl: process.env.DATABASE_URL || '',
  // Accounts are on by default. AUTH=off is a local demo mode where the browser names the approver; never expose it publicly.
  authOn: process.env.AUTH !== 'off',
  // Visitors can create their own account (viewer role only). SIGNUP=off closes it.
  get signupOn() { return this.authOn && process.env.SIGNUP !== 'off'; },
  setupToken: process.env.SETUP_TOKEN || '',
  isProduction: process.env.NODE_ENV === 'production',
  maxBody: 8 * 1024,
  requestsPerMinute: 240,
};
