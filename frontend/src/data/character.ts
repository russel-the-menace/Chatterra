export type Character = {
  name: string
  avatar?: string
  role: string
  company: string
  personality: string
  scenario: string
  goal: string
  language: string
}

const character: Character = {
  name: "David",
  avatar: "",
  role: "Senior Software Engineering Manager",
  company: "US Technology Company",
  personality: "Friendly, professional, and experienced interviewer",
  scenario: "English technical interview",
  goal: "Evaluate communication ability and professional background",
  language: "English only"
}

export default character
