import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'

dotenv.config()
const app = express()

app.use(cors())
app.use(express.json())

app.get('/api/health',(_req,res)=>{
  res.json({status:'ok'})
})

app.post('/api/chat', async (req,res)=>{
  const {message, history, character} = req.body || {}
  const reply = `Thanks for that. Can you tell me about a recent project where you faced a significant challenge and how you resolved it?`;
  res.json({reply})
})

const port = process.env.PORT ? Number(process.env.PORT) : 3000
app.listen(port, ()=> console.log(`Chatterra backend listening on ${port}`))
