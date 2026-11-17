CREATE TABLE categories (name TEXT PRIMARY KEY);
CREATE TABLE resource_categories (
 resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
 category_name TEXT NOT NULL REFERENCES categories(name),
 PRIMARY KEY(resource_id,category_name)
);
CREATE INDEX resource_category_name ON resource_categories(category_name,resource_id);
