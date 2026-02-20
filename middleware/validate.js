/**
 * Fix #16: Lightweight input validation middleware
 * No external dependencies — uses simple rule-based schemas.
 *
 * Usage:
 *   const { validateBody } = require('./middleware/validate');
 *   app.post('/api/foo', validateBody({ name: { required: true, type: 'string', maxLength: 100 } }), handler);
 */

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SAFE_TEXT_REGEX = /^[^<>"'`;]*$/; // Block basic XSS characters

/**
 * Validate a single field value against a rule set.
 * Returns an error string or null if valid.
 */
function validateField(name, value, rules) {
  const isEmpty = value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

  if (rules.required && isEmpty) return `${name} is required`;
  if (isEmpty) return null; // Optional field, skip further checks

  const str = typeof value === 'string' ? value.trim() : String(value);

  if (rules.type === 'email') {
    if (!EMAIL_REGEX.test(str)) return `${name} must be a valid email address`;
  }

  if (rules.type === 'string' || rules.type === 'email') {
    if (!SAFE_TEXT_REGEX.test(str)) return `${name} contains invalid characters`;
    if (rules.minLength && str.length < rules.minLength)
      return `${name} must be at least ${rules.minLength} characters`;
    if (rules.maxLength && str.length > rules.maxLength)
      return `${name} must be at most ${rules.maxLength} characters`;
  }

  if (rules.type === 'number') {
    const num = Number(value);
    if (isNaN(num)) return `${name} must be a number`;
    if (rules.min !== undefined && num < rules.min) return `${name} must be at least ${rules.min}`;
    if (rules.max !== undefined && num > rules.max) return `${name} must be at most ${rules.max}`;
  }

  if (rules.pattern && !rules.pattern.test(str)) {
    return rules.patternMessage || `${name} has an invalid format`;
  }

  return null;
}

/**
 * Middleware factory.  Pass a schema object:
 *   { fieldName: { required, type, minLength, maxLength, min, max, pattern, patternMessage } }
 */
function validateBody(schema) {
  return (req, res, next) => {
    const errors = [];
    for (const [field, rules] of Object.entries(schema)) {
      const err = validateField(field, req.body[field], rules);
      if (err) errors.push(err);
    }
    if (errors.length > 0) {
      return res.status(400).json({ success: false, error: errors[0], errors });
    }
    next();
  };
}

// ── Pre-built schemas for the most critical endpoints ──────────────────────

const loginSchema = {
  email:    { required: true, type: 'email',  maxLength: 254 },
  password: { required: true, type: 'string', minLength: 1, maxLength: 128 },
};

const registerDriverSchema = {
  first_name: { required: true, type: 'string', minLength: 1, maxLength: 100 },
  last_name:  { required: true, type: 'string', minLength: 1, maxLength: 100 },
  email:      { required: true, type: 'email',  maxLength: 254 },
  password:   { required: true, type: 'string', minLength: 8,  maxLength: 128 },
};

const raceEntrySchema = {
  driver_id:  { required: true, type: 'string', minLength: 1, maxLength: 200 },
  race_class: { required: true, type: 'string', minLength: 1, maxLength: 100 },
};

module.exports = { validateBody, validateField, loginSchema, registerDriverSchema, raceEntrySchema };
