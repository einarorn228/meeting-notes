import type { SummaryTemplate } from '../../shared/types'

export const TEMPLATES: SummaryTemplate[] = [
  {
    id: 'fundargerd',
    name: { is: 'Fundargerð (almenn)', en: 'Meeting minutes (general)' },
    description: { is: 'Hefðbundin íslensk fundargerð: samantekt, helstu atriði, ákvarðanir, aðgerðir og næstu skref.', en: 'Classic minutes: summary, key points, decisions, action items, next steps.' },
    instructions: {
      is: 'Skrifaðu hefðbundna íslenska fundargerð. Vertu hnitmiðaður og hlutlægur. Hver aðgerð á að hafa ábyrgðaraðila (nafn í nefnifalli) og frest ef hann kom fram.',
      en: 'Write classic meeting minutes. Be concise and objective. Each action item should have an owner and a due date if mentioned.'
    },
    sections: { is: ['Samantekt', 'Helstu atriði', 'Ákvarðanir', 'Aðgerðir', 'Næstu skref', 'Önnur mál'], en: ['Summary', 'Key points', 'Decisions', 'Action items', 'Next steps', 'Other business'] }
  },
  {
    id: 'stodufundur',
    name: { is: 'Stöðufundur / stand-up', en: 'Status meeting / stand-up' },
    description: { is: 'Staða verkefna, hindranir og næstu skref á hvern þátttakanda.', en: 'Progress, blockers and next steps per participant.' },
    instructions: { is: 'Skiptu eftir þátttakendum eða verkefnum: hvað var gert, hvað er næst, hvaða hindranir eru. Haltu því stuttu.', en: 'Group by participant or project: what was done, what is next, blockers. Keep it short.' },
    sections: { is: ['Samantekt', 'Staða verkefna', 'Hindranir', 'Aðgerðir', 'Næstu skref'], en: ['Summary', 'Project status', 'Blockers', 'Action items', 'Next steps'] }
  },
  {
    id: 'vidskiptavinur',
    name: { is: 'Fundur með viðskiptavini', en: 'Customer meeting' },
    description: { is: 'Þarfir viðskiptavinar, spurningar, loforð og eftirfylgni.', en: 'Customer needs, questions, commitments and follow-ups.' },
    instructions: { is: 'Dragðu fram þarfir og áhyggjur viðskiptavinarins, hvað var lofað, opnar spurningar og eftirfylgni með ábyrgðaraðila.', en: 'Highlight customer needs and concerns, commitments made, open questions and follow-ups with owners.' },
    sections: { is: ['Samantekt', 'Þarfir viðskiptavinar', 'Spurningar og svör', 'Loforð og skuldbindingar', 'Aðgerðir', 'Næstu skref'], en: ['Summary', 'Customer needs', 'Questions and answers', 'Commitments', 'Action items', 'Next steps'] }
  },
  {
    id: 'vidtal',
    name: { is: 'Viðtal', en: 'Interview' },
    description: { is: 'Spurningar, svör og mat.', en: 'Questions, answers and assessment.' },
    instructions: { is: 'Skráðu helstu spurningar og svör, styrkleika, áhyggjuefni og niðurstöðu.', en: 'Record key questions and answers, strengths, concerns and conclusion.' },
    sections: { is: ['Samantekt', 'Spurningar og svör', 'Styrkleikar', 'Áhyggjuefni', 'Niðurstaða', 'Næstu skref'], en: ['Summary', 'Questions and answers', 'Strengths', 'Concerns', 'Conclusion', 'Next steps'] }
  },
  {
    id: 'stjornarfundur',
    name: { is: 'Stjórnarfundur (formleg fundargerð)', en: 'Board meeting (formal minutes)' },
    description: { is: 'Formleg fundargerð með dagskrárliðum, afgreiðslu mála og bókunum.', en: 'Formal minutes with agenda items, resolutions and recorded statements.' },
    instructions: { is: 'Skrifaðu formlega fundargerð. Númeraðu dagskrárliði (1. mál, 2. mál ...) og skráðu niðurstöðu/afgreiðslu hvers máls. Notaðu formlegt málsnið.', en: 'Write formal minutes. Number agenda items and record the resolution of each. Use a formal register.' },
    sections: { is: ['Fundarefni', 'Mættir', 'Dagskrá og afgreiðsla mála', 'Ákvarðanir', 'Aðgerðir', 'Næsti fundur'], en: ['Subject', 'Attendees', 'Agenda and resolutions', 'Decisions', 'Action items', 'Next meeting'] }
  },
  {
    id: 'hugmyndafundur',
    name: { is: 'Hugmyndafundur', en: 'Brainstorm' },
    description: { is: 'Allar hugmyndir flokkaðar, kostir og gallar, hvað var valið.', en: 'All ideas grouped, pros and cons, what was chosen.' },
    instructions: { is: 'Listaðu allar hugmyndir sem komu fram, flokkaðar eftir þema. Tilgreindu kosti og galla sem voru ræddir og hvað var valið til að skoða nánar.', en: 'List every idea raised, grouped by theme, with discussed pros and cons and what was chosen for follow-up.' },
    sections: { is: ['Samantekt', 'Hugmyndir', 'Kostir og gallar', 'Valdar hugmyndir', 'Aðgerðir'], en: ['Summary', 'Ideas', 'Pros and cons', 'Selected ideas', 'Action items'] }
  }
]

export function getTemplate(id?: string): SummaryTemplate {
  return TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0]
}
