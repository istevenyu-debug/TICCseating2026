import BookingApp from '@/components/BookingApp';

export const dynamic = 'force-dynamic';

export default function TicketPage({ params }: { params: { code: string } }) {
  return <BookingApp code={params.code} />;
}
