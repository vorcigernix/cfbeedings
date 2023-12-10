import { Ai } from '@cloudflare/ai'
import { Hono } from 'hono'
const app = new Hono()

app.post('/notes', async (c) => {
	const ai = new Ai(c.env.AI)

	const { text } = await c.req.json()
	if (!text) {
		return c.text("Missing text", 400);
	}

	const { results } = await c.env.DB.prepare("INSERT INTO notes (text) VALUES (?) RETURNING *")
		.bind(text)
		.run()

	const record = results.length ? results[0] : null

	if (!record) {
		return c.text("Failed to create note", 500);
	}
	const messages = [
		{ role: 'system', content: 'You are a friendly summarization assistant. Take the input text and return a summary in three sentences. Please keep your responses concise and limit them to a maximum of 500 tokens. If a summary exceeds this limit, kindly provide the most relevant information within the given constraint.' },
		{ role: 'user', content: text }
	];
	const summary = await ai.run('@cf/mistral/mistral-7b-instruct-v0.1', {
		messages,
		stream: true
	});

	console.log(summary);

	const { data } = await ai.run('@cf/baai/bge-base-en-v1.5', { text: [text] })
	const values = data[0]

	if (!values) {
		return c.text("Failed to generate vector embedding", 500);
	}

	const { id } = record
	const inserted = await c.env.VECTOR_INDEX.upsert([
		{
			id: id.toString(),
			values,
		}
	])

	return c.json({ id, text, inserted })
})

app.get('/', async (c) => {
	const ai = new Ai(c.env.AI);

	const question = c.req.query('text') || "How can you help?"

	const embeddings = await ai.run('@cf/baai/bge-base-en-v1.5', { text: question })
	const vectors = embeddings.data[0]

	const SIMILARITY_CUTOFF = 0.75
	const vectorQuery = await c.env.VECTOR_INDEX.query(vectors, { topK: 1 });
	const vecIds = vectorQuery.matches
		.filter(vec => vec.score > SIMILARITY_CUTOFF)
		.map(vec => vec.vectorId)

	let notes = []
	if (vecIds.length) {
		const query = `SELECT * FROM notes WHERE id IN (${vecIds.join(", ")})`
		const { results } = await c.env.DB.prepare(query).bind().all()
		if (results) notes = results.map(vec => vec.text)
	}

	const contextMessage = notes.length
		? `Context:\n${notes.map(note => `- ${note}`).join("\n")}`
		: ""

	const systemPrompt = `When answering the question or responding, use the context provided, if it is provided and relevant.`

	const { response: answer } = await ai.run(
		'@cf/meta/llama-2-7b-chat-int8',
		{
			messages: [
				...(notes.length ? [{ role: 'system', content: contextMessage }] : []),
				{ role: 'system', content: systemPrompt },
				{ role: 'user', content: question }
			]
		}
	)

	return c.text(answer);
})

app.onError((err, c) => {
	return c.text(err)
})

export default app