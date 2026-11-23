\getenv dbname POSTGRES_DB
\set conninfo 'host=db port=5432 user=repuser password=rep_pass dbname=' :dbname

CREATE SUBSCRIPTION tp_sub
CONNECTION :'conninfo'
PUBLICATION tp_pub
WITH (create_slot = true, slot_name = 'tp_sub_slot', copy_data = true, enabled = true);
