CREATE TRIGGER limit_users BEFORE INSERT ON users
WHEN (SELECT count(*) FROM users) >= 2
BEGIN
  SELECT RAISE(ABORT, 'only two users are allowed');
END;
