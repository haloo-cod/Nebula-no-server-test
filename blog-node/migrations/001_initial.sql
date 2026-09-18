-- Node 模板的 PostgreSQL 初始结构。
-- 迁移通过 `pnpm db:migrate` 执行，不在 Serverless 请求中修改数据库。
create table if not exists schema_migrations (
  version varchar(100) primary key,
  applied_at timestamptz not null default now()
);

create table if not exists users (
  id bigserial primary key,
  username varchar(100) not null unique,
  password_hash varchar(200) not null default '',
  is_admin boolean not null default false,
  email varchar(320) unique,
  display_name varchar(100) not null default '',
  avatar_url varchar(500) not null default '',
  github_id varchar(100) unique,
  email_verified boolean not null default false,
  is_active boolean not null default true,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists auth_sessions (
  id bigserial primary key,
  user_id bigint not null references users(id) on delete cascade,
  token_hash varchar(64) not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists posts (
  id bigserial primary key,
  slug varchar(200) not null unique,
  title varchar(300) not null,
  description text not null default '',
  date varchar(20) not null default '',
  cover_url varchar(500) not null default '',
  category varchar(50) not null default '',
  tags jsonb not null default '[]'::jsonb,
  is_draft boolean not null default false,
  is_pinned boolean not null default false,
  content_html text not null default '',
  content_md text not null default '',
  md_filename varchar(300) not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists gallery_projects (
  id bigserial primary key,
  slug varchar(200) not null unique,
  title varchar(300) not null,
  description text not null default '',
  tags jsonb not null default '[]'::jsonb,
  status varchar(50) not null default '',
  year varchar(10) not null default '',
  is_featured boolean not null default false,
  content_html text not null default '',
  content_md text not null default '',
  md_filename varchar(300) not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists moments (
  id bigserial primary key,
  date timestamptz not null default now(),
  content text not null,
  mood varchar(100) not null default '',
  mood_text varchar(300) not null default '',
  tags jsonb not null default '[]'::jsonb,
  images jsonb not null default '[]'::jsonb,
  likes integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists moment_comments (
  id bigserial primary key,
  moment_id bigint not null references moments(id) on delete cascade,
  nickname varchar(100) not null default '',
  content text not null,
  likes integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists friends (
  id bigserial primary key,
  name varchar(100) not null,
  bio text not null default '',
  avatar varchar(500) not null default '',
  url varchar(500) not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists uploaded_images (
  id bigserial primary key,
  filename varchar(300) not null unique,
  original_name varchar(300) not null,
  url varchar(500) not null,
  file_size integer not null default 0,
  width integer not null default 0,
  height integer not null default 0,
  mime_type varchar(50) not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists carousel_slides (
  id bigserial primary key,
  image_id bigint not null references uploaded_images(id),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists backgrounds (
  id bigserial primary key,
  image_id bigint references uploaded_images(id),
  media_type varchar(10) not null default 'image',
  media_url varchar(1000) not null default '',
  poster_url varchar(1000) not null default '',
  mime_type varchar(100) not null default '',
  file_size integer not null default 0,
  theme varchar(10) not null,
  device varchar(10) not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists albums (
  id bigserial primary key,
  title varchar(200) not null,
  description text not null default '',
  orientation varchar(20) not null default 'portrait',
  cover_image_id bigint references uploaded_images(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists album_photos (
  id bigserial primary key,
  album_id bigint not null references albums(id) on delete cascade,
  image_id bigint not null references uploaded_images(id),
  caption text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists treasures (
  id bigserial primary key,
  slug varchar(200) not null unique,
  title varchar(200) not null,
  description text not null default '',
  category varchar(50) not null default '',
  icon varchar(100) not null default '',
  url varchar(500) not null default '',
  download_file varchar(500) not null default '',
  tags jsonb not null default '[]'::jsonb,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists tavern_posts (
  id bigserial primary key,
  author varchar(100) not null,
  topic varchar(200) not null,
  body text not null,
  ip_hash varchar(64) not null default '',
  is_visible boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists books (
  id bigserial primary key,
  slug varchar(200) not null unique,
  title varchar(300) not null,
  author varchar(200) not null default '',
  description text not null default '',
  cover_url varchar(500) not null default '',
  sort_order integer not null default 0,
  file_path varchar(500) not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists uploaded_files (
  id bigserial primary key,
  filename varchar(500) not null unique,
  original_name varchar(500) not null,
  url varchar(500) not null default '',
  file_size bigint not null default 0,
  mime_type varchar(200) not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists analytics_events (
  id bigserial primary key,
  event_type varchar(40) not null,
  path varchar(500) not null,
  title varchar(300) not null default '',
  referrer varchar(1000) not null default '',
  user_agent varchar(1000) not null default '',
  ip_address varchar(80) not null default '',
  ip_hash varchar(64) not null,
  visitor_id varchar(100) not null default '',
  user_id bigint references users(id) on delete set null,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists comments (
  id bigserial primary key,
  page_key varchar(300) not null,
  user_id bigint references users(id) on delete set null,
  parent_id bigint references comments(id) on delete cascade,
  content text not null,
  legacy_author varchar(100) not null default '',
  legacy_avatar_color varchar(20) not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists site_config (
  id bigserial primary key,
  key varchar(100) not null unique,
  value text not null default '',
  description varchar(300) not null default ''
);

create table if not exists profile (
  id integer primary key default 1,
  name varchar(100) not null default '',
  bio_md text not null default '',
  bio_html text not null default '',
  avatar_url varchar(500) not null default '',
  cover_url varchar(500) not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists social_links (
  id bigserial primary key,
  label varchar(50) not null,
  icon varchar(50) not null,
  url varchar(500) not null,
  sort_order integer not null default 0
);

create index if not exists books_sort_order_idx on books(sort_order, created_at desc);
create index if not exists posts_public_idx on posts(is_draft, is_pinned, date desc);
create index if not exists analytics_event_time_idx on analytics_events(event_type, occurred_at desc);
create index if not exists analytics_ip_hash_idx on analytics_events(ip_hash);
create index if not exists comments_page_idx on comments(page_key, created_at);
