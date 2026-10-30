import { z } from 'zod'

export const EVENTS_SUBSCRIBE_METHOD = 'events.subscribe'

export const EventsSubscribeParams = z.object({}).strict()
export type EventsSubscribeParams = z.infer<typeof EventsSubscribeParams>

export const EventsSubscribeResult = z.object({ subscribed: z.literal(true) })
export type EventsSubscribeResult = z.infer<typeof EventsSubscribeResult>
