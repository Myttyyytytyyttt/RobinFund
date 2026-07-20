/**
 * API HTTP del indexer: GraphQL auto-generado del schema (+ GraphiQL en el navegador) y SQL sobre
 * HTTP para @ponder/client. El frontend consulta aquí; nada de esto toca la chain.
 */
import { db } from "ponder:api";
import schema from "ponder:schema";
import { Hono } from "hono";
import { graphql, client } from "ponder";

const app = new Hono();

app.use("/", graphql({ db, schema }));
app.use("/graphql", graphql({ db, schema }));
app.use("/sql/*", client({ db, schema }));

export default app;
