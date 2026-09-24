CREATE TABLE images (
  filename TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_fold TEXT NOT NULL UNIQUE,
  aliases TEXT NOT NULL,
  description TEXT NOT NULL,
  search_fold TEXT NOT NULL,
  mime TEXT NOT NULL,
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0)
);
