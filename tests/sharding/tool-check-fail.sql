CREATE TABLE tool_fail (id INT);

INSERT INTO tool_fail VALUES (1);

DO $$
BEGIN
    IF current_database() = 'db_b' THEN
        RAISE EXCEPTION 'simulated failure on %', current_database();
    END IF;
END
$$;
