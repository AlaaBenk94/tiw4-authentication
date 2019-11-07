const jwt = require('jsonwebtoken');

const debug = require('debug')('app:authenticate');
const createError = require('http-errors');
const db = require('../models/queries');

// jwt and refresh token secret keys
// the keys must have a size > used algorithm size
const jwtTokenSecret = process.env.SECRET_KEY || 'secretpassword';
const refreshTokenSecret = process.env.REFRESH_SECRET || 'refreshsecretpassword';

// JWT expiry time and refresh Token expiry time
const jwtExpirySeconds = 900; // 5 min
const refreshTokenLifetime = 24 * 60 * 60; // 24h

// TODO : delete later or change it to database
const refreshTokenList = {};

// call postgres to verify request's information
// if OK, creates a jwt and stores it in a cookie, 401 otherwise
async function authenticateUser(req, res, next) {
  const { login } = req.body;
  const pwd = req.body.password;
  const userAgent = req.headers['user-agent'];

  debug(`authenticate_user(): attempt from "${login}" with password "${pwd}"`);
  debug(`user agent is : ${userAgent}`);
  try {
    const ok = await db.checkUser(login, pwd);

    if (!ok) next(createError(401, 'Invalid login/password'));
    else {
      // Create a new token
      const token = jwt.sign({ sub: login }, jwtTokenSecret, {
        algorithm: 'HS256',
        expiresIn: jwtExpirySeconds
      });
      // Create a new refreshToken
      const refreshToken = jwt.sign(
        { sub: login, agent: userAgent },
        refreshTokenSecret,
        { algorithm: 'HS256', expiresIn: refreshTokenLifetime }
      );

      // Add the jwt into a cookie for further reuse
      // see https://www.npmjs.com/package/cookie
      res.cookie('token', token, {
        // secure: true,
        sameSite: true,
        httpOnly: true,
        maxAge: jwtExpirySeconds * 1000 * 2
      });

      // Add refresh token to the cookie
      res.cookie('refreshToken', refreshToken, {
        // secure: true,
        sameSite: true,
        httpOnly: true,
        maxAge: refreshTokenLifetime * 1000 * 2
      });

      // TODO : store refresh token in database (Redis maybe)
      refreshTokenList[refreshToken] = refreshToken;

      debug(`authenticate_user(): "${login}" logged in ("${token}")`);
      next();
    }
  } catch (e) {
    next(createError(500, e));
  }
}

// checks if jwt is present and pertains to some user.
// stores the value in req.user
// eslint-disable-next-line consistent-return
function checkUser(req, _res, next) {
  const { token } = req.cookies;
  debug(`check_user(): checking token "${token}"`);

  if (!token) {
    return next(createError(401, 'No JWT provided'));
  }

  try {
    const payload = jwt.verify(token, jwtTokenSecret);

    if (!payload.sub) next(createError(403, 'User not authorized'));

    debug(`check_user(): "${payload.sub}" authorized`);
    req.user = payload.sub;
    return next();
  } catch (e) {
    if (
      e instanceof jwt.JsonWebTokenError ||
      e instanceof jwt.TokenExpiredError ||
      e instanceof jwt.NotBeforeError
    ) {
      // if the error thrown is because the JWT is unauthorized, return a 401 error
      next(createError(401, e));
    } else {
      // otherwise, return a bad request error
      next(createError(400, e));
    }
  }
}

// checks if refreshToken is present and valid.
// if it is, create new access token
// else the user need to login again
function renewToken(req, res, next) {
  const { refreshToken } = req.cookies;

  debug(`renew_token(): checking refresh token before renewing jwt`);

  if (!refreshToken) {
    debug(`renew_token(): no refresh token found!`);
    next();
  }

  if (!refreshTokenList[refreshToken]) {
    debug(
      `renew_token(): suspecious refresh token (refresh token not found in database)!`
    );
    next();
  }

  // verify integrity of refresh token
  const refreshPayload = jwt.verify(refreshToken, refreshTokenSecret);

  // verify user agent
  if (refreshPayload.agent !== req.headers['user-agent']) {
    debug(
      `renew_token(): user ${refreshPayload.sub} is not using the same machine, you should notify him`
    );
  }

  // generate new acces token
  const newToken = jwt.sign({ sub: refreshPayload.sub }, jwtTokenSecret, {
    algorithm: 'HS256',
    expiresIn: jwtExpirySeconds
  });

  // update cookie
  res.cookie('token', newToken, {
    sameSite: true,
    httpOnly: true,
    maxAge: jwtExpirySeconds * 1000 * 2
  });

  next();
}

module.exports = { checkUser, authenticateUser, renewToken };
