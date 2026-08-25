import RoomApp from "@/components/room-app";

export const metadata = {
  title: "Cinder Room Demo",
  description: "A visual demonstration of the encrypted temporary room interface.",
};

export default function DemoPage() {
  return <RoomApp demo />;
}
