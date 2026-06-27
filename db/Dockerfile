FROM postgres:16
# pg_jsonschema prebuilt for PG16. The .deb is amd64-specific; on an arm64 host
# swap the asset for the arm64 variant from the same release.
ARG PGJ=v0.3.4
ADD https://github.com/supabase/pg_jsonschema/releases/download/${PGJ}/pg_jsonschema-${PGJ}-pg16-amd64-linux-gnu.deb /tmp/pgj.deb
RUN dpkg -i /tmp/pgj.deb && rm /tmp/pgj.deb
