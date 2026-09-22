// ─── App configuration ──────────────────────────────────────────────
// Everything site-specific lives here.

export const APP_ID = '6ab2ddba6dd859465f1b298e';
export const API_BASE = 'https://api.knack.com';

// OAuth client registered for this site's URL (see README → "Changing the web address").
export const CLIENT_ID = '6ab2e9e84ee62a5519479314';

// Choices shown in the app. These MUST match the option lists on the Books table in the
// Knack builder exactly (same spelling/case). To add a board meeting or campus: add the
// option in the builder first, then add it here.
export const BOARD_MEETINGS = ['November 2026', 'January 2027', 'March 2027', 'May 2027'];
export const DEFAULT_BOARD_MEETING = 'November 2026'; // pre-selected on the submit form
export const CAMPUSES = ['CLE', 'CSE', 'KRE', 'LPE', 'MES', 'SE', 'VE', 'WSE', 'LCHS', 'NBHS'];
export const AGE_LEVELS = ['Elementary', 'Middle School', 'High School'];
export const STATUSES = ['Submitted', 'Sent to Luma', 'Approved', 'Approved with Conditions', 'Not Approved', 'Withdrawn'];

// Max alternate ISBNs auto-selected from an online lookup (classics can have hundreds).
export const MAX_AUTO_ALTERNATES = 30;

// ─── Knack schema keys (do not change unless the tables change) ─────
export const OBJ = { books: 'object_3', librarians: 'object_4', admins: 'object_5', isbns: 'object_6' };
export const PROFILE = { librarian: 'profile_4', admin: 'profile_5' };

export const F = {
  title: 'field_23', recordId: 'field_24', createdOn: 'field_25', updatedOn: 'field_26',
  isbn: 'field_53', authors: 'field_54', published: 'field_55', age: 'field_56', campus: 'field_57',
  meeting: 'field_58', status: 'field_59', submittedBy: 'field_60', libNotes: 'field_61', adminNotes: 'field_62',
  sentOn: 'field_63', lumaStatus: 'field_64', lumaConditions: 'field_65', lumaBooklist: 'field_66',
  lumaDateAdded: 'field_67', lumaAddedBy: 'field_68', lumaOrg: 'field_69', lumaCampus: 'field_70',
  lumaImportedOn: 'field_71', isbnCount: 'field_81',
};
export const IF = { isbn: 'field_72', type: 'field_73', book: 'field_80' };
export const LF = { name: 'field_30', email: 'field_31', campus: 'field_41' };

// Where the site lives (works at a domain root or a GitHub Pages sub-folder).
export const APP_BASE = new URL('../', import.meta.url).href;
export const REDIRECT_URI = new URL('auth/callback/', APP_BASE).href;
